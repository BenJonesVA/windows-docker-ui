import type { FastifyInstance } from 'fastify';
import httpProxy from '@fastify/http-proxy';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sandboxInstances, users } from '../db/schema.js';
import { requireAuth } from '../plugins/auth-context.js';
import { cookieSecure } from '../config.js';

const VIEWER_COOKIE_NAME = 'sbx_viewer';
const VIEWER_SESSION_TTL_SECONDS = 60 * 60 * 8; // renewed each time the dashboard opens the viewer

interface ViewerCookiePayload {
  instanceId: string;
  ownerId: string;
  exp: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    // Set by preHandler once it's resolved+validated the instance from the
    // DB, read by getUpstream — avoids getUpstream reconstructing the
    // container name from the id itself (that only happens to agree with
    // the DB's `containerName` column because both derive from the same
    // template string in two places; the DB column is the actual source of
    // truth and is what create/delete already use).
    proxyContainerName?: string;
  }
}

// dockur/windows' viewer JS calls window.location.reload() on WebSocket
// close/error, and the VM reboots repeatedly during Windows setup — so this
// cookie must survive routine reloads for the whole viewing session, not
// just an initial handshake. A short-lived URL-embedded ticket would go dead
// on the first reload; a Path-scoped cookie set once via viewer-session and
// resent automatically on every reload does not have that problem.
export default async function viewerProxyRoutes(fastify: FastifyInstance) {
  fastify.decorateRequest('proxyContainerName', undefined);

  fastify.post(
    '/api/instances/:id/viewer-session',
    { preHandler: requireAuth },
    async (request, reply) => {
      const owner = request.currentUser!;
      const { id } = request.params as { id: string };

      const [instance] = await db
        .select()
        .from(sandboxInstances)
        .where(and(eq(sandboxInstances.id, id), eq(sandboxInstances.ownerId, owner.id)))
        .limit(1);
      if (!instance) return reply.code(404).send({ error: 'not found' });

      const payload: ViewerCookiePayload = {
        instanceId: id,
        ownerId: owner.id,
        exp: Math.floor(Date.now() / 1000) + VIEWER_SESSION_TTL_SECONDS,
      };
      const value = Buffer.from(JSON.stringify(payload)).toString('base64url');

      reply.setCookie(VIEWER_COOKIE_NAME, value, {
        signed: true,
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'lax',
        path: `/api/proxy/${id}/`,
        maxAge: VIEWER_SESSION_TTL_SECONDS,
      });
      return { ok: true, viewerUrl: `/api/proxy/${id}/` };
    },
  );

  await fastify.register(httpProxy, {
    prefix: '/api/proxy/:id',
    upstream: '', // unused — replyOptions.getUpstream supplies the real target per request
    rewritePrefix: '/',
    websocket: true,
    replyOptions: {
      // By the time getUpstream runs, preHandler below has already validated
      // the cookie AND re-checked the DB — the container name is
      // deterministic (`sbx-<id>`), reachable over the per-instance network
      // this webui joined at instance-create time (docker/template.ts).
      getUpstream: (request) => {
        // preHandler always runs first and fails closed if it can't resolve
        // this — the fallback here is unreachable in practice but kept
        // unroutable rather than guessing, matching the fail-closed pattern
        // used throughout this file.
        return request.proxyContainerName ? `http://${request.proxyContainerName}:8006` : 'http://127.0.0.1:1';
      },
    },
    // Confirmed empirically (spike) that preHandler fires for BOTH plain HTTP
    // requests and the WebSocket upgrade request itself (logged for the
    // `/websockify` upgrade specifically, not just asset GETs) — so this is a
    // real gate, not one that's silently bypassed on upgrade.
    preHandler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const cookieValue = request.cookies?.[VIEWER_COOKIE_NAME];

      const fail = () => reply.code(403).send({ error: 'invalid or expired viewer session' });

      if (!cookieValue) return fail();
      const unsigned = fastify.unsignCookie(cookieValue);
      if (!unsigned.valid || !unsigned.value) return fail();

      let payload: ViewerCookiePayload;
      try {
        payload = JSON.parse(Buffer.from(unsigned.value, 'base64url').toString('utf8'));
      } catch {
        return fail();
      }
      if (payload.instanceId !== id || payload.exp < Math.floor(Date.now() / 1000)) {
        return fail();
      }

      // Live re-check on every request, not just at cookie-mint time — a
      // long TTL (8h) would otherwise let a disabled user or a since-deleted
      // instance keep viewer access for hours after either happened.
      const [row] = await db
        .select({
          deletedAt: sandboxInstances.deletedAt,
          userDisabledAt: users.disabledAt,
          containerName: sandboxInstances.containerName,
        })
        .from(sandboxInstances)
        .innerJoin(users, eq(sandboxInstances.ownerId, users.id))
        .where(
          and(
            eq(sandboxInstances.id, id),
            eq(sandboxInstances.ownerId, payload.ownerId),
          ),
        )
        .limit(1);
      if (!row || row.deletedAt || row.userDisabledAt) return fail();
      request.proxyContainerName = row.containerName;

      // The only real activity signal available (dockur/windows has no
      // health/activity API of its own) — the reconciler's idle reaper reads
      // this to decide when a running instance is actually unattended.
      await db
        .update(sandboxInstances)
        .set({ lastSeenAt: Math.floor(Date.now() / 1000) })
        .where(eq(sandboxInstances.id, id));

      // Belt-and-suspenders: strip any forwarded auth material before the
      // proxy dials upstream — the container must never see our cookies.
      delete (request.raw.headers as Record<string, unknown>).cookie;
    },
  });
}
