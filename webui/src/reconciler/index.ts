import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { docker } from '../docker/client.js';
import { db } from '../db/client.js';
import { sandboxInstances, firewallProfiles, users } from '../db/schema.js';
import {
  ensureInstanceFirewall,
  removeInstanceFirewall,
  compileProfilePolicy,
  OPEN_EGRESS_POLICY,
  type EgressPolicy,
} from '../docker/firewall.js';
import { stopInstanceContainer, sharedVolumeNameFor } from '../docker/template.js';
import { ingestInstanceTelemetry } from '../docker/telemetry.js';
import { getActiveTier, resolveMaxLifetimeSeconds } from '../db/resourceTiers.js';
import { pruneOldProcessEvents } from '../db/processEvents.js';

const PENDING_GRACE_SECONDS = 2 * 60; // how long a create is allowed to be mid-flight
const READINESS_PROBE_TIMEOUT_MS = 2000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const SANDBOX_LABEL = 'sandbox.instance_id';

// SAFETY INVARIANT: every Docker call in this module is scoped to containers
// carrying `sandbox.instance_id` (via the list filter below) or to networks
// matching the `sbx-*-net` naming convention this app itself uses. The dev
// daemon this runs against has an unrelated, long-lived `portainer-ce`
// container with no such label — it must never be touched by this sweep.
// The label filter is what Docker's own API uses to decide what's even
// returned to us; the check below double-checks it anyway as defense in
// depth, and logs-and-skips rather than throwing so one weird container
// can't abort the rest of the sweep (reaping, orphan-network cleanup) too.
function isLabeled(container: { Labels?: Record<string, string> }): boolean {
  return Boolean(container.Labels?.[SANDBOX_LABEL]);
}

async function syncContainerStates(log: FastifyBaseLogger) {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [SANDBOX_LABEL] },
  });

  for (const container of containers) {
    if (!isLabeled(container)) {
      log.error({ containerId: container.Id }, 'safety invariant violated — unlabeled container in filtered list, skipping');
      continue;
    }
    const instanceId = container.Labels[SANDBOX_LABEL];

    const [row] = await db
      .select()
      .from(sandboxInstances)
      .where(eq(sandboxInstances.id, instanceId))
      .limit(1);

    if (!row || row.deletedAt) {
      // Orphan: a labeled container with no live DB row behind it (crashed
      // create, or DB restored from an older backup). Log loudly; don't
      // auto-remove — an operator should look at this rather than the
      // reconciler silently destroying state it doesn't fully understand.
      log.warn({ instanceId, containerId: container.Id }, 'orphaned sandbox container with no matching DB row');
      continue;
    }

    const mapped =
      container.State === 'running'
        ? 'running'
        : container.State === 'created'
          ? 'created'
          : container.State === 'exited' || container.State === 'dead'
            ? 'exited'
            : 'error';

    if (mapped !== row.containerState) {
      await db
        .update(sandboxInstances)
        .set({ containerState: mapped })
        .where(eq(sandboxInstances.id, instanceId));
    }
  }
}

// The only readiness signal available — dockur/windows has no health
// endpoint (established during planning) — is whether its web viewer
// responds at all yet. Without this, `phase` never leaves 'installing' and
// reapIdleAndExpired's `phase = 'ready'` guard makes it permanently dead
// code — confirmed this was happening (phase was only ever written at
// insert-time and on the create-failure path, never transitioned forward).
async function probeReadiness(log: FastifyBaseLogger) {
  const installing = await db
    .select()
    .from(sandboxInstances)
    .where(
      and(
        eq(sandboxInstances.phase, 'installing'),
        eq(sandboxInstances.containerState, 'running'),
        isNull(sandboxInstances.deletedAt),
      ),
    );

  for (const instance of installing) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), READINESS_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`http://${instance.containerName}:8006/`, { signal: controller.signal });
      if (res.ok) {
        await db
          .update(sandboxInstances)
          .set({ phase: 'ready' })
          .where(eq(sandboxInstances.id, instance.id));
        log.info({ instanceId: instance.id }, 'instance web viewer responded — phase -> ready');
      }
    } catch {
      // Not up yet — normal during install, try again next sweep.
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function reapIdleAndExpired(log: FastifyBaseLogger) {
  const now = Math.floor(Date.now() / 1000);
  const tier = await getActiveTier();
  const running = await db
    .select({ instance: sandboxInstances, ownerMaxUptimeOverrideSeconds: users.maxUptimeOverrideSeconds })
    .from(sandboxInstances)
    .innerJoin(users, eq(sandboxInstances.ownerId, users.id))
    .where(
      and(
        eq(sandboxInstances.containerState, 'running'),
        eq(sandboxInstances.phase, 'ready'), // never reap during install
        isNull(sandboxInstances.deletedAt),
      ),
    );

  for (const row of running) {
    const instance = row.instance;
    if (!instance.containerId) continue;
    const lastActive = instance.lastSeenAt ?? instance.startedAt ?? instance.createdAt;
    const idleFor = now - lastActive;
    const ageFor = now - instance.createdAt;
    const maxLifetime = resolveMaxLifetimeSeconds(
      instance.maxUptimeOverrideSeconds,
      row.ownerMaxUptimeOverrideSeconds,
      tier.maxLifetimeSeconds,
    );

    const reason =
      idleFor > tier.idleTimeoutSeconds
        ? 'idle-timeout'
        : ageFor > maxLifetime
          ? 'max-lifetime'
          : null;
    if (!reason) continue;

    log.info({ instanceId: instance.id, reason, idleFor, ageFor }, 'reaping instance');
    await stopInstanceContainer(instance.containerId).catch((err) => {
      log.error({ err, instanceId: instance.id }, 'failed to stop instance during reap');
    });
    await db
      .update(sandboxInstances)
      .set({ containerState: 'exited', stoppedAt: now })
      .where(eq(sandboxInstances.id, instance.id));
  }
}

// A crash between the DB insert and the container/network/volume actually
// being created leaves a row stuck at containerState='pending' forever —
// syncContainerStates only handles the reverse case (a container with no
// row). Mark these failed after a grace period rather than silently leaving
// them to confuse a future "list my instances" call.
async function reapStalePendingRows(log: FastifyBaseLogger) {
  const cutoff = Math.floor(Date.now() / 1000) - PENDING_GRACE_SECONDS;
  const stale = await db
    .select()
    .from(sandboxInstances)
    .where(
      and(
        eq(sandboxInstances.containerState, 'pending'),
        isNull(sandboxInstances.deletedAt),
        lt(sandboxInstances.createdAt, cutoff),
      ),
    );

  for (const instance of stale) {
    log.warn({ instanceId: instance.id }, 'instance stuck pending past grace period — marking failed');
    await db
      .update(sandboxInstances)
      .set({ containerState: 'error', phase: 'failed' })
      .where(eq(sandboxInstances.id, instance.id));
  }
}

// Reverse of template.ts's networkNameFor — sliced by fixed prefix/suffix
// length rather than split('-'), since nanoid ids can themselves contain
// dashes.
function instanceIdFromNetworkName(name: string): string {
  return name.slice('sbx-'.length, -'-net'.length);
}

// Host iptables rules (docker/firewall.ts) are populated straight into
// netfilter, not persisted by Docker itself — a host reboot wipes them.
// Reapplying idempotently every sweep (ensureInstanceFirewall no-ops once a
// rule is already present — confirmed via -C during development) means a
// reboot self-heals within one SWEEP_INTERVAL_MS instead of needing a
// separate host-side systemd unit to reinstall them. Also the mechanism that
// converges each instance's egress policy (plan item #16) to its actual
// firewall state — ensureInstanceFirewall rebuilds the instance's chain to
// match the stored policy every call, so a policy change that raced a
// crash/restart still lands within one sweep.
async function ensureFirewallRules(log: FastifyBaseLogger) {
  const instances = await db
    .select({
      id: sandboxInstances.id,
      egressMode: sandboxInstances.egressMode,
      egressAllowlist: sandboxInstances.egressAllowlist,
      firewallProfileId: sandboxInstances.firewallProfileId,
    })
    .from(sandboxInstances)
    .where(isNull(sandboxInstances.deletedAt));

  // Batched rather than one lookup per 'profile'-mode instance.
  const profileIds = [
    ...new Set(
      instances
        .filter((i) => i.egressMode === 'profile' && i.firewallProfileId)
        .map((i) => i.firewallProfileId as string),
    ),
  ];
  const profileById = new Map(
    profileIds.length
      ? (await db.select().from(firewallProfiles).where(inArray(firewallProfiles.id, profileIds))).map((p) => [p.id, p] as const)
      : [],
  );

  const policyById = new Map<string, EgressPolicy>();
  for (const instance of instances) {
    if (instance.egressMode === 'profile') {
      const profile = instance.firewallProfileId ? profileById.get(instance.firewallProfileId) : undefined;
      if (!profile) {
        // Referenced profile is missing — shouldn't happen (deletion is
        // guarded in api/firewallProfiles.ts while any instance still
        // references it), but fail closed rather than silently falling open
        // if it ever does.
        log.error(
          { instanceId: instance.id, firewallProfileId: instance.firewallProfileId },
          'assigned firewall profile not found — blocking egress',
        );
        policyById.set(instance.id, { mode: 'blocked', allowlist: [] });
      } else {
        policyById.set(instance.id, compileProfilePolicy(profile));
      }
      continue;
    }
    let allowlist: string[] = [];
    try {
      allowlist = JSON.parse(instance.egressAllowlist);
    } catch (err) {
      log.error({ err, instanceId: instance.id }, 'invalid egress_allowlist JSON — treating as empty');
    }
    policyById.set(instance.id, { mode: instance.egressMode, allowlist });
  }

  const networks = await docker.listNetworks();
  for (const network of networks) {
    if (!network.Name?.startsWith('sbx-') || !network.Name.endsWith('-net')) continue;
    const instanceId = instanceIdFromNetworkName(network.Name);
    // Orphan network (no live DB row) — leave egress open; reapOrphanNetworks
    // reaps it separately, and there's no stored intent to converge toward.
    const policy = policyById.get(instanceId) ?? OPEN_EGRESS_POLICY;
    await ensureInstanceFirewall(network.Id, policy).catch((err) => {
      log.error({ err, network: network.Name }, 'failed to (re)apply instance firewall rules');
    });
  }
}

// Plan item #13 — reads any closed telemetry buckets off each instance's
// /shared volume and inserts them into process_events (docker/telemetry.ts).
// Not gated on containerState === 'running': the guest can write its last
// bucket right up until shutdown, and the volume (unlike the container)
// persists across a stop, so a stopped-but-not-deleted instance can still
// have unread data sitting there worth collecting. Per-instance try/catch —
// one instance's helper-container hiccup shouldn't block ingesting the rest,
// same defensive shape as ensureFirewallRules below.
async function ingestTelemetry(log: FastifyBaseLogger) {
  const instances = await db
    .select({ id: sandboxInstances.id })
    .from(sandboxInstances)
    .where(isNull(sandboxInstances.deletedAt));

  for (const instance of instances) {
    await ingestInstanceTelemetry(instance.id, sharedVolumeNameFor(instance.id)).catch((err) => {
      log.error({ err, instanceId: instance.id }, 'failed to ingest process telemetry');
    });
  }
}

// Crashed creates (or a killed reconciler mid-teardown) can leave a
// `sbx-<id>-net` network behind with nothing attached — these silently eat
// the address-pool budget (see plan's address-pool note) until reaped.
async function reapOrphanNetworks(log: FastifyBaseLogger) {
  const networks = await docker.listNetworks();
  for (const network of networks) {
    if (!network.Name?.startsWith('sbx-') || !network.Name.endsWith('-net')) continue;
    const detail = await docker.getNetwork(network.Id).inspect();
    const hasContainers = detail.Containers && Object.keys(detail.Containers).length > 0;
    if (hasContainers) continue;

    log.info({ network: network.Name }, 'removing orphaned sandbox network');
    // This bypasses template.ts's leaveSelfAndRemoveNetwork (self was never
    // joined to an orphan with no containers), so firewall cleanup has to
    // happen here explicitly — otherwise ensureFirewallRules re-adds these
    // rules every sweep just before this function deletes the network out
    // from under them, leaking 5 permanent rules per orphan, forever.
    await removeInstanceFirewall(network.Id).catch((err) => {
      log.warn({ err, network: network.Name }, 'failed to remove firewall rules for orphaned network');
    });
    await docker.getNetwork(network.Id).remove().catch((err) => {
      log.warn({ err, network: network.Name }, 'failed to remove orphaned network');
    });
  }
}

export function startReconciler(log: FastifyBaseLogger): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // skip overlapping runs rather than queueing
    running = true;
    try {
      await syncContainerStates(log);
      await probeReadiness(log);
      await reapIdleAndExpired(log);
      await reapStalePendingRows(log);
      await ensureFirewallRules(log);
      await reapOrphanNetworks(log);
      await ingestTelemetry(log);
      await pruneOldProcessEvents(Math.floor(Date.now() / 1000)).catch((err) => {
        log.error({ err }, 'failed to prune old process events');
      });
    } catch (err) {
      log.error({ err }, 'reconciler sweep failed');
    } finally {
      running = false;
    }
  }, SWEEP_INTERVAL_MS);

  return () => clearInterval(timer);
}
