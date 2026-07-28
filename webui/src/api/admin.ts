import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, sandboxInstances, resourceTiers } from '../db/schema.js';
import { requireAdmin } from '../plugins/auth-context.js';
import { serializeInstance } from './serialize.js';
import { getActiveTier } from '../db/resourceTiers.js';
import { updateResourceTierSchema, setMaxUptimeOverrideSchema } from '../docker/validators.js';

// Plan item #6 — admin panel: user management, admin-wide instance
// visibility, and (plan item #14) the resource tier that replaces what used
// to be hardcoded constants in reconciler/index.ts and docker/validators.ts.
export default async function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAdmin);

  fastify.get('/api/admin/users', async () => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        createdAt: users.createdAt,
        disabledAt: users.disabledAt,
      })
      .from(users);
    return rows;
  });

  // Toggles disabledAt — resolveSession (auth/session.ts) already refuses a
  // disabled user's session on every request, so this takes effect
  // immediately, not just on next login.
  fastify.post('/api/admin/users/:id/disable', async (request, reply) => {
    const admin = request.currentUser!;
    const { id } = request.params as { id: string };
    if (id === admin.id) {
      return reply.code(400).send({ error: 'cannot disable your own account' });
    }
    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) return reply.code(404).send({ error: 'not found' });

    await db.update(users).set({ disabledAt: Math.floor(Date.now() / 1000) }).where(eq(users.id, id));
    return { ok: true };
  });

  fastify.post('/api/admin/users/:id/enable', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) return reply.code(404).send({ error: 'not found' });

    await db.update(users).set({ disabledAt: null }).where(eq(users.id, id));
    return { ok: true };
  });

  // Every instance across every owner — the one thing a regular user's own
  // GET /api/instances deliberately can't see (that route scopes to
  // ownerId). Read-only: start/stop/delete/rename/egress still go through
  // the owner-scoped routes in api/instances.ts, unchanged — this is
  // oversight, not a parallel management surface.
  fastify.get('/api/admin/instances', async () => {
    const rows = await db
      .select({ instance: sandboxInstances, ownerEmail: users.email })
      .from(sandboxInstances)
      .innerJoin(users, eq(sandboxInstances.ownerId, users.id));
    return rows
      .filter((r) => !r.instance.deletedAt)
      .map((r) => ({ ...serializeInstance(r.instance), ownerEmail: r.ownerEmail }));
  });

  // Plan item #14 — a single row today (see schema.ts's comment on
  // resourceTiers); getActiveTier() lazily seeds it on first read, so this
  // always returns something even before any admin has touched it.
  fastify.get('/api/admin/resource-tier', async () => {
    return getActiveTier();
  });

  fastify.put('/api/admin/resource-tier', async (request, reply) => {
    const parsed = updateResourceTierSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const tier = await getActiveTier(); // ensures the row exists before updating it
    await db.update(resourceTiers).set(parsed.data).where(eq(resourceTiers.id, tier.id));
    const [updated] = await db.select().from(resourceTiers).where(eq(resourceTiers.id, tier.id)).limit(1);
    return updated;
  });

  // Plan item #14 — admin force-cap/force-suspend of a single running
  // instance ahead of the tier's default lifetime, without changing the tier
  // for everyone else. Not owner-scoped (deliberately — this is an admin
  // action on any instance, not the owner's own routes in api/instances.ts).
  fastify.post('/api/admin/instances/:id/max-uptime', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = setMaxUptimeOverrideSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const [instance] = await db.select().from(sandboxInstances).where(eq(sandboxInstances.id, id)).limit(1);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    await db
      .update(sandboxInstances)
      .set({ maxUptimeOverrideSeconds: parsed.data.maxUptimeOverrideSeconds })
      .where(eq(sandboxInstances.id, id));
    return { ok: true };
  });
}
