import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sandboxInstances, type SandboxInstance } from '../db/schema.js';
import { requireAuth } from '../plugins/auth-context.js';
import { docker } from '../docker/client.js';
import { ensureInstanceFirewall } from '../docker/firewall.js';
import {
  createInstanceSchema,
  setEgressPolicySchema,
  renameInstanceSchema,
  ALLOWED_WINDOWS_VERSIONS,
  VERSION_DISK_MIN_GB,
  DISK_GB_MAX,
  RAM_MB_MIN,
  RAM_MB_MAX,
  CPU_CORES_MIN,
  CPU_CORES_MAX,
} from '../docker/validators.js';
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
} from '../docker/template.js';

// egress_allowlist is stored as a JSON string (see db/schema.ts) — parse it
// before it ever reaches a client, so every response gives callers a real
// array instead of a string they'd have to know to JSON.parse themselves.
function serializeInstance(row: SandboxInstance) {
  let egressAllowlist: string[] = [];
  try {
    egressAllowlist = JSON.parse(row.egressAllowlist);
  } catch {
    // Malformed stored value — surface as empty rather than throwing a 500
    // on every read; reconciler/index.ts's ensureFirewallRules logs this
    // same condition loudly on the enforcement side.
  }
  return { ...row, egressAllowlist };
}

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

async function getOwnedInstance(instanceId: string, ownerId: string) {
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
  // hand-maintained copy that can silently drift out of sync with
  // docker/validators.ts (the actual server-side enforcement).
  fastify.get('/api/instances/meta', async () => ({
    versions: ALLOWED_WINDOWS_VERSIONS,
    diskMinByVersion: VERSION_DISK_MIN_GB,
    diskMaxGb: DISK_GB_MAX,
    ramMinMb: RAM_MB_MIN,
    ramMaxMb: RAM_MB_MAX,
    cpuMinCores: CPU_CORES_MIN,
    cpuMaxCores: CPU_CORES_MAX,
    // Plan item #19 — the pinned base image is the one piece of "OS image"
    // this app actually controls (dockur/windows fetches the Windows ISO
    // itself at first boot; this project has no hook into that, so there's
    // nothing to list/remove there).
    baseImage: IMAGE_REF,
  }));

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
    const rows = await db
      .select()
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.ownerId, owner.id)));
    return rows.filter((r) => !r.deletedAt).map(serializeInstance);
  });

  fastify.post('/api/instances', async (request, reply) => {
    const owner = request.currentUser!;
    const parsed = createInstanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const input = parsed.data;
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
    return reply.code(201).send(serializeInstance(final));
  });

  fastify.get('/api/instances/:id', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    return serializeInstance(instance);
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
    return serializeInstance(updated);
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

    const allowlist = parsed.data.mode === 'allowlist' ? (parsed.data.allowlist ?? []) : [];
    await db
      .update(sandboxInstances)
      .set({ egressMode: parsed.data.mode, egressAllowlist: JSON.stringify(allowlist) })
      .where(eq(sandboxInstances.id, id));

    const network = await docker
      .getNetwork(networkNameFor(id))
      .inspect()
      .catch((err: any) => {
        if (err.statusCode === 404) return null;
        throw err;
      });
    if (network) {
      await ensureInstanceFirewall(network.Id, { mode: parsed.data.mode, allowlist });
    }
    return { ok: true, egressMode: parsed.data.mode, egressAllowlist: allowlist };
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
