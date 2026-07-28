import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { firewallProfiles, sandboxInstances } from '../db/schema.js';
import { requireAuth } from '../plugins/auth-context.js';
import { serializeFirewallProfile } from './serialize.js';
import { firewallProfileSchema } from '../docker/validators.js';
import { docker } from '../docker/client.js';
import { networkNameFor } from '../docker/template.js';
import { ensureInstanceFirewall, compileProfilePolicy } from '../docker/firewall.js';

async function getOwnedProfile(id: string, ownerId: string) {
  const [row] = await db
    .select()
    .from(firewallProfiles)
    .where(and(eq(firewallProfiles.id, id), eq(firewallProfiles.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

// Plan item #24 — CRUD for saved, reusable, graphically-edited firewall
// profiles. Owner-scoped throughout, same as api/instances.ts, since
// profiles are per-user rather than a shared admin resource like
// resource_tiers — a user shouldn't be able to assign, edit, or even see
// another user's profile (IDOR risk on the assign-to-instance path in
// api/instances.ts's egress route otherwise).
export default async function firewallProfileRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/firewall-profiles', async (request) => {
    const owner = request.currentUser!;
    const rows = await db.select().from(firewallProfiles).where(eq(firewallProfiles.ownerId, owner.id));
    return rows.map(serializeFirewallProfile);
  });

  fastify.get('/api/firewall-profiles/:id', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const row = await getOwnedProfile(id, owner.id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return serializeFirewallProfile(row);
  });

  fastify.post('/api/firewall-profiles', async (request, reply) => {
    const owner = request.currentUser!;
    const parsed = firewallProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const id = nanoid(16);
    const [inserted] = await db
      .insert(firewallProfiles)
      .values({
        id,
        ownerId: owner.id,
        name: parsed.data.name,
        defaultAction: parsed.data.defaultAction,
        rules: JSON.stringify(parsed.data.rules),
        nodeLayout: JSON.stringify(parsed.data.nodeLayout ?? {}),
      })
      .returning();
    return reply.code(201).send(serializeFirewallProfile(inserted));
  });

  // Reapplies immediately to every instance currently assigned this profile
  // — editing a profile's rules should take effect right away, not only on
  // the next reconciler sweep, same "apply now, reconciler self-heals
  // otherwise" pattern as the per-instance egress route in
  // api/instances.ts.
  fastify.put('/api/firewall-profiles/:id', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const parsed = firewallProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const existing = await getOwnedProfile(id, owner.id);
    if (!existing) return reply.code(404).send({ error: 'not found' });

    await db
      .update(firewallProfiles)
      .set({
        name: parsed.data.name,
        defaultAction: parsed.data.defaultAction,
        rules: JSON.stringify(parsed.data.rules),
        nodeLayout: JSON.stringify(parsed.data.nodeLayout ?? {}),
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(firewallProfiles.id, id));

    const [updated] = await db.select().from(firewallProfiles).where(eq(firewallProfiles.id, id)).limit(1);
    const assigned = await db
      .select()
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.firewallProfileId, id), isNull(sandboxInstances.deletedAt)));

    const policy = compileProfilePolicy(updated);
    for (const instance of assigned) {
      const network = await docker
        .getNetwork(networkNameFor(instance.id))
        .inspect()
        .catch((err: any) => {
          if (err.statusCode === 404) return null;
          throw err;
        });
      if (network) {
        await ensureInstanceFirewall(network.Id, policy).catch((err) => {
          request.log.error({ err, instanceId: instance.id }, 'failed to reapply updated firewall profile');
        });
      }
    }
    return serializeFirewallProfile(updated);
  });

  // Refuses to delete a profile still assigned to a live instance (409)
  // rather than picking a fallback policy on the caller's behalf — losing a
  // profile out from under a running instance is a security-relevant
  // surprise, so the caller must reassign it first (mirrors why deletion is
  // guarded at all rather than just cascading).
  fastify.delete('/api/firewall-profiles/:id', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const existing = await getOwnedProfile(id, owner.id);
    if (!existing) return reply.code(404).send({ error: 'not found' });

    const inUse = await db
      .select({ id: sandboxInstances.id })
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.firewallProfileId, id), isNull(sandboxInstances.deletedAt)));
    if (inUse.length > 0) {
      return reply.code(409).send({ error: `profile is assigned to ${inUse.length} instance(s) — reassign them first` });
    }

    // The 409 guard above only blocks on LIVE references — a soft-deleted
    // instance (deletedAt set) can still hold this profile's id, and
    // db/client.ts runs with `PRAGMA foreign_keys = ON`, so deleting the row
    // out from under that reference would throw an FK violation. Clear any
    // remaining references first; by this point they can only belong to
    // soft-deleted rows; nulling them is inert (nothing reads egress
    // fields on a deleted instance).
    await db.update(sandboxInstances).set({ firewallProfileId: null }).where(eq(sandboxInstances.firewallProfileId, id));
    await db.delete(firewallProfiles).where(eq(firewallProfiles.id, id));
    return { ok: true };
  });
}
