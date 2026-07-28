import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, sandboxInstances } from '../db/schema.js';
import { requireAdmin } from '../plugins/auth-context.js';
import { serializeInstance } from './serialize.js';

// Plan item #6 — admin panel, scoped to user management and admin-wide
// instance visibility. Resource-tier editing (RAM/CPU/disk bounds, idle/
// lifetime timeouts) is plan item #14, a separate DB table this doesn't
// touch — see reconciler/index.ts and docker/validators.ts for where those
// hardcoded constants currently live.
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
}
