import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveSession, SESSION_COOKIE_NAME } from '../auth/session.js';
import type { User } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User | null;
    sessionId: string | null;
  }
}

export default fp(async function authContext(fastify: FastifyInstance) {
  fastify.decorateRequest('currentUser', null);
  fastify.decorateRequest('sessionId', null);

  fastify.addHook('onRequest', async (request) => {
    const cookieValue = request.cookies[SESSION_COOKIE_NAME];
    const resolved = await resolveSession(cookieValue);
    request.currentUser = resolved?.user ?? null;
    request.sessionId = resolved?.sessionId ?? null;
  });
});

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'authentication required' });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'authentication required' });
    return;
  }
  if (request.currentUser.role !== 'admin') {
    reply.code(403).send({ error: 'admin only' });
  }
}
