import { loadConfig } from './config';
import { createDb, runMigrations } from './db';
import { buildApp } from './app';
import { seedLibrary } from './routes/library';
import { bootstrapAdmin, purgeDeleted, scheduleNightly } from './services/maintenance';

async function main() {
  const cfg = loadConfig();
  const { db, pool } = createDb(cfg.DATABASE_URL);
  const app = await buildApp(cfg, db);
  const log = app.log;

  // R-5: migrate, seed the device library, first admin
  for (let attempt = 1; ; attempt++) {
    try {
      await runMigrations(db, cfg.MIGRATIONS_DIR);
      break;
    } catch (err: any) {
      if (attempt >= 30 || !/ECONNREFUSED|ENOTFOUND|starting up|EAI_AGAIN/.test(String(err?.message ?? err) + (err?.code ?? '')))
        throw err;
      log.warn({ attempt }, 'database not ready, retrying');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log.info('migrations applied');
  if (await seedLibrary(db)) log.info('device library seeded');
  const admin = await bootstrapAdmin(db, cfg);
  if (admin === 'created') log.info({ email: cfg.ADMIN_EMAIL }, 'first admin created');
  if (admin === 'skipped') log.warn('no users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set');
  await app.ctx.jobs.recover();

  scheduleNightly(async () => log.info({ purged: await purgeDeleted(db) }, 'nightly purge'));

  await app.listen({ port: cfg.PORT, host: cfg.HOST });

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // JSON to stdout like the rest of the logs (R-9)
  console.log(JSON.stringify({ level: 60, time: Date.now(), msg: 'startup failed', err: String(err?.stack ?? err) }));
  process.exit(1);
});
