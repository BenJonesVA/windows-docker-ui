import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sandboxInstances, type SandboxInstance } from '../db/schema.js';
import { requireAuth } from '../plugins/auth-context.js';
import { docker } from '../docker/client.js';
import { ensureInstanceFirewall } from '../docker/firewall.js';
import {
  createInstanceSchema,
  setEgressPolicySchema,
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
  }));

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
