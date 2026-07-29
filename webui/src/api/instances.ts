import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sandboxInstances, firewallProfiles, type ResourceTier } from '../db/schema.js';
import { requireAuth } from '../plugins/auth-context.js';
import { serializeInstance } from './serialize.js';
import { docker } from '../docker/client.js';
import { ensureInstanceFirewall, compileProfilePolicy, type EgressPolicy } from '../docker/firewall.js';
import {
  buildCreateInstanceSchema,
  setEgressPolicySchema,
  renameInstanceSchema,
  ALLOWED_WINDOWS_VERSIONS,
  VERSION_DISK_MIN_GB,
} from '../docker/validators.js';
import { getActiveTier, resolveMaxLifetimeSeconds } from '../db/resourceTiers.js';
import { listRecentProcessEvents } from '../db/processEvents.js';
import {
  createInstanceContainer,
  startInstanceContainer,
  stopInstanceContainer,
  removeInstanceContainer,
  inspectInstanceContainer,
  tailInstanceLogs,
  demuxDockerLogs,
  networkNameFor,
  IMAGE_REF,
  getInstanceStats,
  captureInstanceScreenshot,
} from '../docker/template.js';

// Own the mapping from Docker's raw state string to our narrower enum here,
// rather than trusting arbitrary values into the DB column.
function mapContainerState(dockerState: string | undefined): 'created' | 'running' | 'exited' | 'error' {
  switch (dockerState) {
    case 'running':
      return 'running';
    case 'created':
      return 'created';
    case 'exited':
    case 'dead':
      return 'exited';
    default:
      return 'error';
  }
}

// Plan item #15 — sibling to the per-instance bounds in
// docker/validators.ts's buildCreateInstanceSchema: a single instance can be
// within bounds while a user's Nth *concurrent* one still exhausts the host.
// "Live" here means not soft-deleted — a stopped-but-undeleted instance
// still holds its volume (disk) and counts toward "how many instances does
// this user have", even though it isn't currently running.
async function checkUserQuota(
  ownerId: string,
  tier: ResourceTier,
  input: { ramMb: number; diskGb: number },
): Promise<string | null> {
  const live = await db
    .select({ ramMb: sandboxInstances.ramMb, diskGb: sandboxInstances.diskGb })
    .from(sandboxInstances)
    .where(and(eq(sandboxInstances.ownerId, ownerId), isNull(sandboxInstances.deletedAt)));

  if (live.length >= tier.maxConcurrentInstances) {
    return `Concurrent instance limit reached (${tier.maxConcurrentInstances}).`;
  }
  const currentRamMb = live.reduce((sum, i) => sum + i.ramMb, 0);
  if (currentRamMb + input.ramMb > tier.maxAggregateRamMb) {
    return `Aggregate RAM limit would be exceeded (max ${tier.maxAggregateRamMb} MB across all your instances).`;
  }
  const currentDiskGb = live.reduce((sum, i) => sum + i.diskGb, 0);
  if (currentDiskGb + input.diskGb > tier.maxAggregateDiskGb) {
    return `Aggregate disk limit would be exceeded (max ${tier.maxAggregateDiskGb} GB across all your instances).`;
  }
  return null;
}

export async function getOwnedInstance(instanceId: string, ownerId: string) {
  const [instance] = await db
    .select()
    .from(sandboxInstances)
    .where(and(eq(sandboxInstances.id, instanceId), eq(sandboxInstances.ownerId, ownerId)))
    .limit(1);
  return instance ?? null;
}

export default async function instanceRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth);

  // Lets the create form render real, enforced bounds instead of a
  // hand-maintained copy that can silently drift out of sync with the
  // active resource tier (docker/validators.ts's buildCreateInstanceSchema
  // — the actual server-side enforcement, built from the same tier below).
  fastify.get('/api/instances/meta', async () => {
    const tier = await getActiveTier();
    return {
      versions: ALLOWED_WINDOWS_VERSIONS,
      diskMinByVersion: VERSION_DISK_MIN_GB,
      diskMaxGb: tier.diskGbMax,
      ramMinMb: tier.ramMbMin,
      ramMaxMb: tier.ramMbMax,
      cpuMinCores: tier.cpuCoresMin,
      cpuMaxCores: tier.cpuCoresMax,
      // Lets the detail page's countdown show which limit (idle vs. max
      // lifetime) will actually reap the instance first — see
      // reconciler/index.ts reapIdleAndExpired for the enforcement itself.
      idleTimeoutSeconds: tier.idleTimeoutSeconds,
      // Plan item #15 — surfaced so the create form can explain a 409 in
      // advance rather than only after a failed submit.
      maxConcurrentInstances: tier.maxConcurrentInstances,
      maxAggregateRamMb: tier.maxAggregateRamMb,
      maxAggregateDiskGb: tier.maxAggregateDiskGb,
      // Plan item #19 — the pinned base image is the one piece of "OS image"
      // this app actually controls (dockur/windows fetches the Windows ISO
      // itself at first boot; this project has no hook into that, so there's
      // nothing to list/remove there).
      baseImage: IMAGE_REF,
    };
  });

  // Plan item #19 — soft-deleted instances (DELETE /api/instances/:id with
  // retain_disk=true) leave their Docker volume behind with no way to see or
  // reclaim it afterward: the instance row still exists (deletedAt set) but
  // nothing in the UI ever queries deleted rows again. Filters to volumes
  // that still actually exist — a row whose volume was already removed
  // (retain_disk=false, or a later manual cleanup) shouldn't linger in this
  // list forever.
  fastify.get('/api/instances/retained-volumes', async (request) => {
    const owner = request.currentUser!;
    const rows = await db
      .select()
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.ownerId, owner.id), isNotNull(sandboxInstances.deletedAt)));

    const retained = await Promise.all(
      rows.map(async (row) => {
        const exists = await docker
          .getVolume(row.volumeName)
          .inspect()
          .then(() => true)
          .catch((err: any) => {
            if (err.statusCode === 404) return false;
            throw err;
          });
        return exists ? { instanceId: row.id, name: row.name, volumeName: row.volumeName, deletedAt: row.deletedAt } : null;
      }),
    );
    return retained.filter(Boolean);
  });

  // Permanently removes a retained disk. Scoped to the owner's own
  // soft-deleted rows only — getOwnedInstance doesn't filter on deletedAt,
  // so this works whether or not the row was already soft-deleted, but
  // there's no route that exposes this for a LIVE instance (that path is
  // DELETE /api/instances/:id's own retain_disk=false option instead).
  // Already-gone is treated as success, not an error — the whole point of
  // this route is "make sure this volume doesn't exist," and it doesn't
  // matter whether that was already true.
  fastify.delete('/api/instances/:id/volume', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    if (!instance.deletedAt) {
      return reply.code(409).send({ error: 'instance is not deleted — use DELETE /api/instances/:id first' });
    }

    await docker
      .getVolume(instance.volumeName)
      .remove()
      .catch((err: any) => {
        if (err.statusCode !== 404) throw err;
      });
    return { ok: true };
  });

  fastify.get('/api/instances', async (request) => {
    const owner = request.currentUser!;
    const tier = await getActiveTier();
    const rows = await db
      .select()
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.ownerId, owner.id)));
    return rows
      .filter((r) => !r.deletedAt)
      .map((r) => ({
        ...serializeInstance(r),
        maxLifetimeSeconds: resolveMaxLifetimeSeconds(r.maxUptimeOverrideSeconds, owner.maxUptimeOverrideSeconds, tier.maxLifetimeSeconds),
      }));
  });

  fastify.post('/api/instances', async (request, reply) => {
    const owner = request.currentUser!;
    const tier = await getActiveTier();
    const parsed = buildCreateInstanceSchema(tier).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const input = parsed.data;

    const quotaError = await checkUserQuota(owner.id, tier, input);
    if (quotaError) {
      return reply.code(409).send({ error: quotaError });
    }

    const id = nanoid(16);
    const containerName = `sbx-${id}`;
    const volumeName = `sbx-${id}-storage`;

    const [inserted] = await db
      .insert(sandboxInstances)
      .values({
        id,
        ownerId: owner.id,
        name: input.name,
        windowsVersion: input.windowsVersion,
        ramMb: input.ramMb,
        cpuCores: input.cpuCores,
        diskGb: input.diskGb,
        containerName,
        volumeName,
        containerState: 'pending',
        phase: 'installing',
      })
      .returning();

    try {
      const { containerId, accountPassword } = await createInstanceContainer(
        { id, ownerId: owner.id, containerName, volumeName },
        input,
      );
      await startInstanceContainer(containerId);
      await db
        .update(sandboxInstances)
        .set({
          containerId,
          accountPassword,
          containerState: 'running',
          startedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(sandboxInstances.id, id));
    } catch (err) {
      request.log.error({ err, instanceId: id }, 'failed to create/start sandbox container');
      await db
        .update(sandboxInstances)
        .set({ containerState: 'error', phase: 'failed' })
        .where(eq(sandboxInstances.id, id));
      return reply.code(502).send({ error: 'failed to create sandbox container', instance: inserted });
    }

    const [final] = await db.select().from(sandboxInstances).where(eq(sandboxInstances.id, id));
    return reply.code(201).send({
      ...serializeInstance(final),
      maxLifetimeSeconds: resolveMaxLifetimeSeconds(final.maxUptimeOverrideSeconds, owner.maxUptimeOverrideSeconds, tier.maxLifetimeSeconds),
    });
  });

  fastify.get('/api/instances/:id', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    const tier = await getActiveTier();
    return {
      ...serializeInstance(instance),
      maxLifetimeSeconds: resolveMaxLifetimeSeconds(instance.maxUptimeOverrideSeconds, owner.maxUptimeOverrideSeconds, tier.maxLifetimeSeconds),
    };
  });

  // Plan item #20 — display name only. containerName/volumeName (the actual
  // Docker resource names) are set once at create time and never change;
  // renaming never touches Docker at all, just the DB row.
  fastify.patch('/api/instances/:id', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const parsed = renameInstanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    await db
      .update(sandboxInstances)
      .set({ name: parsed.data.name })
      .where(eq(sandboxInstances.id, id));
    const [updated] = await db.select().from(sandboxInstances).where(eq(sandboxInstances.id, id));
    const tier = await getActiveTier();
    return {
      ...serializeInstance(updated),
      maxLifetimeSeconds: resolveMaxLifetimeSeconds(updated.maxUptimeOverrideSeconds, owner.maxUptimeOverrideSeconds, tier.maxLifetimeSeconds),
    };
  });

  fastify.post('/api/instances/:id/start', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    if (!instance.containerId) return reply.code(409).send({ error: 'no container to start' });

    await startInstanceContainer(instance.containerId);
    await db
      .update(sandboxInstances)
      .set({ containerState: 'running', startedAt: Math.floor(Date.now() / 1000), stoppedAt: null })
      .where(eq(sandboxInstances.id, id));
    return { ok: true };
  });

  fastify.post('/api/instances/:id/stop', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    if (!instance.containerId) return reply.code(409).send({ error: 'no container to stop' });

    await stopInstanceContainer(instance.containerId);
    await db
      .update(sandboxInstances)
      .set({ containerState: 'exited', stoppedAt: Math.floor(Date.now() / 1000) })
      .where(eq(sandboxInstances.id, id));
    return { ok: true };
  });

  // Live per-instance egress policy (plan item #16) — distinct from a future
  // admin-set per-tier default (plan item #14, not yet implemented).
  // Persists the policy unconditionally, then applies it immediately if the
  // instance's network already exists; otherwise (still pending/no network
  // yet) the next reconciler sweep converges it (see reconciler/index.ts
  // ensureFirewallRules), same pattern as the baseline firewall rules
  // already rely on. No phase-gate here (e.g. rejecting 'blocked'/
  // 'allowlist' while phase === 'installing', which would hang the Windows
  // ISO fetch) — consistent with every other action route in this file not
  // phase-gating either; the UI disables the control during install instead
  // (InstanceDetail.tsx).
  fastify.post('/api/instances/:id/egress', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const parsed = setEgressPolicySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    const allowlist = parsed.data.mode === 'allowlist' ? parsed.data.allowlist : [];

    // 'profile' mode delegates to a saved firewall_profiles row instead of
    // egressAllowlist — resolved here (owner-scoped, so assigning someone
    // else's profile 404s rather than leaking its existence) and compiled
    // to the same EgressPolicy shape every other mode produces.
    let policy: EgressPolicy;
    let firewallProfileId: string | null = null;
    if (parsed.data.mode === 'profile') {
      const [profile] = await db
        .select()
        .from(firewallProfiles)
        .where(and(eq(firewallProfiles.id, parsed.data.firewallProfileId), eq(firewallProfiles.ownerId, owner.id)))
        .limit(1);
      if (!profile) return reply.code(404).send({ error: 'firewall profile not found' });
      firewallProfileId = profile.id;
      policy = compileProfilePolicy(profile);
    } else {
      policy = { mode: parsed.data.mode, allowlist };
    }

    await db
      .update(sandboxInstances)
      .set({ egressMode: parsed.data.mode, egressAllowlist: JSON.stringify(allowlist), firewallProfileId })
      .where(eq(sandboxInstances.id, id));

    const network = await docker
      .getNetwork(networkNameFor(id))
      .inspect()
      .catch((err: any) => {
        if (err.statusCode === 404) return null;
        throw err;
      });
    if (network) {
      await ensureInstanceFirewall(network.Id, policy);
    }
    return { ok: true, egressMode: parsed.data.mode, egressAllowlist: allowlist, firewallProfileId };
  });

  fastify.delete('/api/instances/:id', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const query = request.query as { retain_disk?: string };
    const retainDisk = query.retain_disk === 'true';

    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    if (instance.containerId) {
      await removeInstanceContainer(instance.containerId, {
        instanceId: id,
        removeVolume: !retainDisk,
        volumeName: instance.volumeName,
      });
    }
    await db
      .update(sandboxInstances)
      .set({ deletedAt: Math.floor(Date.now() / 1000) })
      .where(eq(sandboxInstances.id, id));
    return { ok: true };
  });

  fastify.get('/api/instances/:id/status', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    if (!instance.containerId) return { containerState: instance.containerState, phase: instance.phase };

    const info = await inspectInstanceContainer(instance.containerId).catch(() => null);
    const containerState = mapContainerState(info?.State?.Status);
    return { containerState, phase: instance.phase, dockerState: info?.State };
  });

  // Plan item #12 — live CPU/memory usage. 409 rather than zeros when not
  // running: Docker's stats endpoint has nothing meaningful to report for a
  // stopped container, and a caller silently getting "0% / 0 bytes" back
  // would be indistinguishable from a genuinely idle-but-running instance.
  fastify.get('/api/instances/:id/stats', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    if (!instance.containerId || instance.containerState !== 'running') {
      return reply.code(409).send({ error: 'instance is not running' });
    }

    const stats = await getInstanceStats(instance.containerId).catch((err) => {
      request.log.error({ err, instanceId: id }, 'failed to read container stats');
      return null;
    });
    if (!stats) return reply.code(502).send({ error: 'failed to read container stats' });
    return stats;
  });

  // Plan item #13 — process execution telemetry. Deliberately NOT gated on
  // containerState, unlike /stats and /screenshot: rows are historical
  // (already ingested off the guest by the reconciler — see
  // reconciler/index.ts's ingestTelemetry), so a stopped instance's past
  // activity is still worth reading, same "works whether running or not"
  // posture as the shared-files routes.
  fastify.get('/api/instances/:id/processes', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    const query = request.query as { limit?: string };
    const parsedLimit = Number(query.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;

    const events = await listRecentProcessEvents(id, limit).catch((err) => {
      request.log.error({ err, instanceId: id }, 'failed to read process events');
      return null;
    });
    if (events === null) return reply.code(502).send({ error: 'failed to read process events' });
    return events;
  });

  // Plan item #7 — hover-to-preview thumbnail. Same not-running 409 shape as
  // /stats: a stopped/installing instance has no QEMU monitor socket to
  // screendump, and returning a placeholder image would look identical to a
  // slow-but-real capture. 502 on failure covers the case where the
  // container IS running but the guest hasn't finished booting QEMU/the
  // monitor socket yet (screendump timeout) — expected during the first
  // stretch of `phase: 'installing'`, not just a hard error.
  fastify.get('/api/instances/:id/screenshot', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    if (!instance.containerId || instance.containerState !== 'running') {
      return reply.code(409).send({ error: 'instance is not running' });
    }

    const png = await captureInstanceScreenshot(instance.containerId).catch((err) => {
      request.log.warn({ err, instanceId: id }, 'failed to capture instance screenshot');
      return null;
    });
    if (!png) return reply.code(502).send({ error: 'failed to capture screenshot' });

    reply.header('Cache-Control', 'no-store');
    reply.type('image/png');
    return reply.send(png);
  });

  // SSE tail of container logs — the only install-progress signal available,
  // since dockur/windows has no health endpoint of its own.
  fastify.get('/api/instances/:id/logs', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance || !instance.containerId) return reply.code(404).send({ error: 'not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const containerId = instance.containerId;
    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    while (!closed) {
      const logs = await tailInstanceLogs(containerId, 5).catch(() => Buffer.alloc(0));
      if (logs.length) {
        reply.raw.write(`data: ${JSON.stringify(demuxDockerLogs(logs))}\n\n`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    reply.raw.end();
  });
}
