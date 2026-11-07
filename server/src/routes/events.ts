import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Id } from '@sixpoint/shared';
import { initials, requireUser } from '../lib/auth';
import { requireProject } from '../services/projects';

/** Server-Sent Events stream of project changes (R-51) with presence (R-53). */
export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, hub } = app.ctx;

  app.get(
    '/api/projects/:id/events',
    {
      schema: {
        tags: ['projects'],
        params: z.object({ id: Id }),
        querystring: z.object({ clientId: z.string().max(64).optional() }),
        description: 'text/event-stream of marker, floor, project, upload and presence events.',
      },
      preHandler: requireUser,
    },
    async (req, reply) => {
      await requireProject(db, req.params.id);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const u = req.user!;
      const unsubscribe = hub.subscribe(req.params.id, res, {
        userId: u.id,
        name: u.name,
        initials: initials(u.name),
        clientId: req.query.clientId ?? req.clientId ?? '',
      });
      req.raw.on('close', unsubscribe);
    },
  );
};
