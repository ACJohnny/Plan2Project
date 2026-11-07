import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = server/src (tsx) or server/dist (built); both are two levels below the repo root.
const repoRoot = path.resolve(here, '../..');

const Env = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET is required (at least 16 characters)'),
  APP_URL: z.string().url().default('http://localhost:8080'),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_NAME: z.string().default('Administrator'),
  UPLOAD_MAX_MB: z.coerce.number().positive().default(100),
  PDF_RENDER_DPI: z.coerce.number().int().min(36).max(600).default(150),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('/data'),
  STATIC_DIR: z.string().default(path.join(repoRoot, 'web/dist')),
  MIGRATIONS_DIR: z.string().default(path.join(repoRoot, 'server/drizzle')),
  SAMPLES_DIR: z.string().default(path.join(repoRoot, 'docs/samples')),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof Env> & { secureCookies: boolean; appOrigin: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration — ${msg}`);
  }
  const c = parsed.data;
  return { ...c, secureCookies: c.APP_URL.startsWith('https'), appOrigin: new URL(c.APP_URL).origin };
}
