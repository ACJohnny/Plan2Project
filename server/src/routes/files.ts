import fs from 'node:fs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpError, requireUser } from '../lib/auth';

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** Sheet images, signed-in users only (R-68). Names are content hashes, so they cache forever (R-20). */
export const fileRoutes: FastifyPluginAsyncZod = async (app) => {
  const { storage } = app.ctx;
  app.get('/files/sheets/:name', { schema: { hide: true }, preHandler: requireUser }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!/^[a-f0-9]{32}(\.preview|\.thumb)?\.(png|jpg|webp)$/.test(name))
      throw new HttpError(404, 'Not found');
    const abs = storage.abs(`sheets/${name}`);
    let stat;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    reply.header('Content-Type', TYPES[name.split('.').pop()!]);
    reply.header('Content-Length', stat.size);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(abs));
  });
};
