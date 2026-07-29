import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import authContext from './plugins/auth-context.js';
import authRoutes from './api/auth.js';
import setupRoutes from './api/setup.js';
import instanceRoutes from './api/instances.js';
import fileRoutes from './api/files.js';
import firewallProfileRoutes from './api/firewallProfiles.js';
import adminRoutes from './api/admin.js';
import proxyRoutes from './proxy/viewer.js';
import staticRoutes from './plugins/static.js';
import { docker } from './docker/client.js';
import { SELF_CONTAINER_NAME } from './docker/template.js';
import { startReconciler } from './reconciler/index.js';

const app = Fastify({ logger: true });

// Fail loudly here rather than surfacing a confusing dockerode error on the
// first instance create — every instance's dedicated network needs to know
// this container's identity to join it (see docker/template.ts).
if (!SELF_CONTAINER_NAME) {
  app.log.error('SELF_CONTAINER_NAME is not set — required to join per-instance networks');
  process.exit(1);
}
await docker
  .getContainer(SELF_CONTAINER_NAME)
  .inspect()
  .catch((err) => {
    app.log.error({ err, SELF_CONTAINER_NAME }, 'SELF_CONTAINER_NAME does not resolve to a running container');
    process.exit(1);
  });

// COOKIE_SECRET signs the viewer-session cookie (proxy/viewer.ts). Falling
// back to a random value means viewer cookies won't survive a restart in
// dev, which is fine; set COOKIE_SECRET explicitly in production so restarts
// don't force everyone to reopen their viewer.
await app.register(cookie, {
  secret: process.env.COOKIE_SECRET ?? randomBytes(32).toString('hex'),
});
await app.register(authContext);
await app.register(authRoutes);
await app.register(setupRoutes);
await app.register(instanceRoutes);
await app.register(fileRoutes);
await app.register(firewallProfileRoutes);
await app.register(adminRoutes);
await app.register(proxyRoutes);
await app.register(staticRoutes);

const stopReconciler = startReconciler(app.log);
app.addHook('onClose', (_instance, done) => {
  stopReconciler();
  done();
});

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: '0.0.0.0' });
