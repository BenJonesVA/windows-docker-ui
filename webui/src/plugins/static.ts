import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

// Resolves correctly from both `src/plugins/static.ts` (dev, via tsx) and the
// compiled `dist/plugins/static.js` (prod) — both sit one level under a
// sibling of `web/`, so walking up two directories lands on `web/dist` either
// way.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

export default async function staticRoutes(fastify: FastifyInstance) {
  await fastify.register(fastifyStatic, {
    root: webRoot,
    // Only serve files that actually exist under web/dist — react-router
    // owns everything else, handled by the SPA fallback below rather than
    // this plugin's own wildcard.
    wildcard: false,
  });

  // Client-side routes (e.g. a refresh on /instances/abc) have no matching
  // file or API route — fall back to index.html so react-router can take
  // over. Anything under /api/ that reaches here is a genuine unmatched
  // route, not a SPA path, so it gets a real 404 instead of an HTML page.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}
