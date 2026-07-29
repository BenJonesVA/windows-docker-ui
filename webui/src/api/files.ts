import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { requireAuth } from '../plugins/auth-context.js';
import { getOwnedInstance } from './instances.js';
import { sharedVolumeNameFor } from '../docker/template.js';
import { listSharedFiles, uploadSharedFile, downloadSharedFile, deleteSharedFile, MAX_FILE_BYTES } from '../docker/files.js';
import { sharedFileNameSchema } from '../docker/validators.js';

// Plan item #9/#18, resolved 2026-07-28: scoped file exchange via
// dockur/windows' own built-in Samba share (docker/template.ts's SAMBA=Y +
// the per-instance /shared volume), not a host filesystem path. Every route
// here works against that volume through a short-lived helper container
// (docker/files.ts) — deliberately NOT gated on the instance actually
// running, unlike /stats or /screenshot: the volume (and therefore its
// files) exists independently of whether the sandbox container is up, so a
// stopped instance's shared files are still manageable.
export default async function fileRoutes(fastify: FastifyInstance) {
  // Scoped to this plugin's own encapsulation context, not registered
  // globally — @fastify/reply-from (proxy/viewer.ts) warns on its own
  // onReady hook if @fastify/multipart is registered anywhere on the root
  // instance, since multipart bodies aren't proxy-safe by default. The
  // viewer proxy only ever handles GET/websocket traffic in practice, so
  // that combination was functionally harmless here, but there's no reason
  // to trigger the warning (or widen multipart's reach) when scoping it to
  // just these routes is one line.
  await fastify.register(multipart, { limits: { fileSize: MAX_FILE_BYTES } });
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/instances/:id/files', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    const files = await listSharedFiles(sharedVolumeNameFor(id)).catch((err) => {
      request.log.error({ err, instanceId: id }, 'failed to list shared files');
      return null;
    });
    if (files === null) return reply.code(502).send({ error: 'failed to list shared files' });
    return files;
  });

  fastify.post('/api/instances/:id/files', async (request, reply) => {
    const owner = request.currentUser!;
    const { id } = request.params as { id: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    // @fastify/multipart is registered globally with a matching fileSize
    // limit (index.ts) — that limit protects the request body itself; this
    // route's own MAX_FILE_BYTES check in docker/files.ts guards the case
    // where multipart's limit is ever loosened without this staying in sync.
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: 'no file provided' });

    const parsedName = sharedFileNameSchema.safeParse(upload.filename);
    if (!parsedName.success) {
      return reply.code(400).send({ error: 'invalid filename', details: parsedName.error.flatten() });
    }

    const data = await upload.toBuffer();
    if (upload.file.truncated) {
      return reply.code(413).send({ error: `file exceeds the ${MAX_FILE_BYTES} byte limit` });
    }

    const error = await uploadSharedFile(sharedVolumeNameFor(id), parsedName.data, data)
      .then(() => null)
      .catch((err) => {
        request.log.warn({ err, instanceId: id }, 'failed to upload shared file');
        return err instanceof Error ? err.message : 'upload failed';
      });
    if (error) return reply.code(502).send({ error });
    return reply.code(201).send({ ok: true });
  });

  fastify.get('/api/instances/:id/files/:filename', async (request, reply) => {
    const owner = request.currentUser!;
    const { id, filename } = request.params as { id: string; filename: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    const parsedName = sharedFileNameSchema.safeParse(filename);
    if (!parsedName.success) return reply.code(400).send({ error: 'invalid filename' });

    const data = await downloadSharedFile(sharedVolumeNameFor(id), parsedName.data).catch((err) => {
      request.log.warn({ err, instanceId: id }, 'failed to download shared file');
      return null;
    });
    if (data === null) return reply.code(404).send({ error: 'file not found' });

    // Two forms, per RFC 6266/5987: an ASCII-only fallback (Node's own
    // setHeader throws ERR_INVALID_CHAR on any codepoint above U+00FF, so a
    // filename with, say, an em dash — the exact case this was caught on —
    // would 500 on a plain `filename="..."` header) plus the real name as
    // filename*=, which browsers prefer whenever both are present.
    const asciiName = parsedName.data.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(parsedName.data)}`,
    );
    reply.type('application/octet-stream');
    return reply.send(data);
  });

  fastify.delete('/api/instances/:id/files/:filename', async (request, reply) => {
    const owner = request.currentUser!;
    const { id, filename } = request.params as { id: string; filename: string };
    const instance = await getOwnedInstance(id, owner.id);
    if (!instance) return reply.code(404).send({ error: 'not found' });

    const parsedName = sharedFileNameSchema.safeParse(filename);
    if (!parsedName.success) return reply.code(400).send({ error: 'invalid filename' });

    const ok = await deleteSharedFile(sharedVolumeNameFor(id), parsedName.data)
      .then(() => true)
      .catch((err) => {
        request.log.warn({ err, instanceId: id }, 'failed to delete shared file');
        return false;
      });
    if (!ok) return reply.code(502).send({ error: 'failed to delete file' });
    return { ok: true };
  });
}
