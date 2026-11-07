import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config';
import { createDb, runMigrations } from '../src/db';
import { buildApp } from '../src/app';
import { seedLibrary } from '../src/routes/library';
import { bootstrapAdmin } from '../src/services/maintenance';

export const ORIGIN = 'http://localhost:8080';

/** Fresh database + data dir per test file, against TEST_DATABASE_URL (a throwaway Postgres). */
export async function setupApp() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is not set (run via scripts/dev-shell.sh with TEST_DB=1)');
  const name = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = base.replace(/\/[^/]+$/, `/${name}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-'));
  const cfg = loadConfig({
    DATABASE_URL: url,
    SESSION_SECRET: 'test-secret-test-secret-test-secret',
    APP_URL: ORIGIN,
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'admin-password',
    DATA_DIR: dataDir,
    STATIC_DIR: path.join(dataDir, 'no-static'),
    MIGRATIONS_DIR: path.resolve(__dirname, '../drizzle'),
    PDF_RENDER_DPI: '150',
  });
  const { db, pool } = createDb(url);
  await runMigrations(db, cfg.MIGRATIONS_DIR);
  await seedLibrary(db);
  await bootstrapAdmin(db, cfg);
  const app = await buildApp(cfg, db, { logger: false });
  await app.ready();
  return {
    app,
    db,
    cfg,
    async close() {
      await app.close();
      await pool.end();
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

type App = Awaited<ReturnType<typeof setupApp>>['app'];

export async function login(app: App, email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'sp_sid')!;
  return client(app, `sp_sid=${cookie.value}`);
}

export function client(app: App, cookie: string, clientId = 'test-client') {
  const headers = { cookie, origin: ORIGIN, 'x-client-id': clientId };
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as any, url, headers, payload: payload as any });
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* not json */
    }
    return { status: res.statusCode, json, body: res.body, headers: res.headers, raw: res.rawPayload };
  };
  return {
    cookie,
    get: (u: string) => call('GET', u),
    post: (u: string, b?: unknown) => call('POST', u, b ?? {}),
    put: (u: string, b?: unknown) => call('PUT', u, b),
    patch: (u: string, b?: unknown) => call('PATCH', u, b),
    del: (u: string) => call('DELETE', u),
    async upload(url: string, file: string, filename = path.basename(file)) {
      const boundary = '----spmtest' + Math.random().toString(16).slice(2);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        fs.readFileSync(file),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      return { status: res.statusCode, json: res.json() };
    },
  };
}

export const SAMPLES = path.resolve(__dirname, '../../docs/samples');
