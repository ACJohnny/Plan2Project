import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import type { Config } from './config';
import type { DB } from './db';
import { HttpError, LoginLimiter, resolveSession, resolveToken, SESSION_COOKIE } from './lib/auth';
import { EventHub } from './lib/events';
import { Storage } from './lib/storage';
import { PdfJobs } from './services/jobs';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { projectRoutes } from './routes/projects';
import { floorRoutes } from './routes/floors';
import { markerRoutes } from './routes/markers';
import { libraryRoutes } from './routes/library';
import { exportRoutes } from './routes/exports';
import { tokenRoutes } from './routes/tokens';
import { eventRoutes } from './routes/events';
import { fileRoutes } from './routes/files';

export interface Ctx {
  cfg: Config;
  db: DB;
  storage: Storage;
  hub: EventHub;
  limiter: LoginLimiter;
  jobs: PdfJobs;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
}

export type App = FastifyInstance & { withTypeProvider: FastifyInstance['withTypeProvider'] };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestOrigin(req: FastifyRequest): string {
  // trustProxy is on, so protocol/host honor X-Forwarded-Proto / X-Forwarded-Host (R-7).
  return `${req.protocol}://${req.host}`;
}

export async function buildApp(cfg: Config, db: DB, opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: cfg.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const storage = new Storage(cfg.DATA_DIR);
  await storage.init();
  const hub = new EventHub();
  const ctx: Ctx = { cfg, db, storage, hub, limiter: new LoginLimiter(), jobs: null as unknown as PdfJobs };
  ctx.jobs = new PdfJobs(ctx, app.log);
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => hub.close());

  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await app.register(multipart, { limits: { fileSize: cfg.UPLOAD_MAX_MB * 1024 * 1024, files: 1 } });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Six Point Markup API',
        version: '1.0.0',
        description:
          'JSON REST API. Browser clients use the session cookie; scripts send `Authorization: Bearer <token>` with an admin-created read-only token.',
      },
      components: {
        securitySchemes: {
          cookie: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
          bearer: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ cookie: [] }, { bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('clientId', null);

  // Authentication: session cookie or bearer token.
  app.addHook('onRequest', async (req, reply) => {
    const cid = req.headers['x-client-id'];
    req.clientId = typeof cid === 'string' && cid.length <= 64 ? cid : null;
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) {
      req.user = await resolveToken(db, authz.slice(7).trim());
      return;
    }
    const signed = req.cookies[SESSION_COOKIE];
    if (!signed) return;
    const un = req.unsignCookie(signed);
    if (!un.valid || !un.value) return;
    const s = await resolveSession(db, un.value);
    if (!s) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return;
    }
    req.user = s.user;
    req.sessionId = s.sid;
    if (s.renew) {
      reply.setCookie(SESSION_COOKIE, signed, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: cfg.secureCookies,
        maxAge: 30 * 24 * 3600,
      });
    }
  });

  // CSRF: state-changing cookie-authenticated requests must come from our own origin (R-14).
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;
    if (req.headers.authorization?.startsWith('Bearer ')) return;
    const origin = (req.headers.origin as string | undefined) ?? refererOrigin(req.headers.referer);
    if (!origin) throw new HttpError(403, 'Missing Origin header');
    if (origin !== cfg.appOrigin && origin !== requestOrigin(req))
      throw new HttpError(403, 'Cross-origin request blocked');
  });

  // Tokens are read-only.
  app.addHook('preHandler', async (req) => {
    if (req.user?.via === 'token' && !SAFE_METHODS.has(req.method))
      throw new HttpError(403, 'API tokens are read-only');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: 'Invalid request', details: err.validation });
    }
    if (err instanceof HttpError)
      return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.status(413).send({ error: `File is larger than ${cfg.UPLOAD_MAX_MB} MB` });
    if (err.code === '23505') return reply.status(409).send({ error: 'Already exists' });
    if (err.statusCode && err.statusCode < 500)
      return reply.status(err.statusCode).send({ error: err.message });
    req.log.error({ err }, 'request failed');
    if (process.env.VITEST) console.error(err);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  app.get('/healthz', { schema: { hide: true }, logLevel: 'warn' }, async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(projectRoutes);
  await app.register(floorRoutes);
  await app.register(markerRoutes);
  await app.register(libraryRoutes);
  await app.register(exportRoutes);
  await app.register(tokenRoutes);
  await app.register(eventRoutes);
  await app.register(fileRoutes);

  // Static SPA (R-1): long-cache hashed assets, index.html never cached.
  if (fs.existsSync(path.join(cfg.STATIC_DIR, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: cfg.STATIC_DIR,
      wildcard: false,
      index: false,
      setHeaders(res, p) {
        if (p.includes(`${path.sep}assets${path.sep}`))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });
    app.get('/*', { schema: { hide: true } }, (req, reply) => {
      const rel = decodeURIComponent((req.params as any)['*'] ?? '');
      if (rel.startsWith('api/') || rel.startsWith('files/'))
        return reply.status(404).send({ error: 'Not found' });
      const file = path.join(cfg.STATIC_DIR, rel);
      if (rel && file.startsWith(cfg.STATIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile())
        return reply.sendFile(rel);
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  }

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: `Not found: ${req.method} ${req.url}` }),
  );

  return app;
}

function refererOrigin(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
}
