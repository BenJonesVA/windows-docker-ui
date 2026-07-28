import { and, eq, isNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { docker } from '../docker/client.js';
import { db } from '../db/client.js';
import { sandboxInstances } from '../db/schema.js';
import { stopInstanceContainer } from '../docker/template.js';

// Vertical-slice defaults — move to per-tier resource_tiers columns once that
// table exists (plan task #8). Deliberately conservative.
const IDLE_TIMEOUT_SECONDS = 30 * 60; // 30 min
const MAX_LIFETIME_SECONDS = 8 * 60 * 60; // 8 h
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
  const running = await db
    .select()
    .from(sandboxInstances)
    .where(
      and(
        eq(sandboxInstances.containerState, 'running'),
        eq(sandboxInstances.phase, 'ready'), // never reap during install
        isNull(sandboxInstances.deletedAt),
      ),
    );

  for (const instance of running) {
    if (!instance.containerId) continue;
    const lastActive = instance.lastSeenAt ?? instance.startedAt ?? instance.createdAt;
    const idleFor = now - lastActive;
    const ageFor = now - instance.createdAt;

    const reason =
      idleFor > IDLE_TIMEOUT_SECONDS
        ? 'idle-timeout'
        : ageFor > MAX_LIFETIME_SECONDS
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
      await reapOrphanNetworks(log);
    } catch (err) {
      log.error({ err }, 'reconciler sweep failed');
    } finally {
      running = false;
    }
  }, SWEEP_INTERVAL_MS);

  return () => clearInterval(timer);
}
