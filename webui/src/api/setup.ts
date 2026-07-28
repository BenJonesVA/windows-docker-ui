import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { createSession, SESSION_COOKIE_NAME } from '../auth/session.js';
import { cookieSecure } from '../config.js';

const setupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
});

// Plan item #5 — first-boot admin bootstrap. Distinct from an eventual
// admin-invite flow for adding MORE accounts later (see the "task #8" TODO
// in api/auth.ts) — this route only ever does one thing: get a fresh deploy
// from zero users to one admin, replacing the manual `npm run db:seed` step.
export default async function setupRoutes(fastify: FastifyInstance) {
  fastify.get('/api/setup/status', async () => {
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    return { needsSetup: existing.length === 0 };
  });

  // Re-checks the count at request time rather than trusting the client's
  // last /status read — closes the window where two browser tabs could both
  // see needsSetup:true and both submit.
  fastify.post('/api/setup', async (request, reply) => {
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'setup already completed' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const id = nanoid(16);
    await db.insert(users).values({ id, email: parsed.data.email, passwordHash, role: 'admin' });

    const session = await createSession(id);
    reply.setCookie(SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: new Date(session.expiresAt * 1000),
    });
    return reply.code(201).send({ id, email: parsed.data.email, role: 'admin' });
  });
}
