import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, destroySession, SESSION_COOKIE_NAME } from '../auth/session.js';
import { requireAuth } from '../plugins/auth-context.js';
import { cookieSecure } from '../config.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export default async function authRoutes(fastify: FastifyInstance) {
  // TODO(plan #6, remaining scope): replace with admin-invite-only
  // registration. For now, the first account comes from the Setup screen
  // (plan #5, api/setup.ts) and every account after that from
  // `npm run db:seed` — there's no in-app way for an admin to create or
  // invite additional users yet.
  fastify.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    // Constant-shape response whether the email exists or not, to avoid
    // trivially enumerating registered accounts via response differences.
    if (!user || user.disabledAt) {
      await verifyPassword(
        '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        password,
      ).catch(() => {});
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    const session = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: new Date(session.expiresAt * 1000),
    });
    return { id: user.id, email: user.email, role: user.role };
  });

  fastify.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    if (request.sessionId) await destroySession(request.sessionId);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  fastify.get('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    const user = request.currentUser!;
    return { id: user.id, email: user.email, role: user.role };
  });
}
