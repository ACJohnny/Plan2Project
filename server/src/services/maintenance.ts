import { sql } from 'drizzle-orm';
import type { DB } from '../db';
import { users } from '../db/schema';
import { hashPassword, purgeExpiredSessions } from '../lib/auth';
import type { Config } from '../config';

/** R-5: create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when no users exist. */
export async function bootstrapAdmin(db: DB, cfg: Config): Promise<'created' | 'exists' | 'skipped'> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  if (n > 0) return 'exists';
  if (!cfg.ADMIN_EMAIL || !cfg.ADMIN_PASSWORD) return 'skipped';
  await db.insert(users).values({
    email: cfg.ADMIN_EMAIL.trim().toLowerCase(),
    name: cfg.ADMIN_NAME,
    role: 'admin',
    passwordHash: await hashPassword(cfg.ADMIN_PASSWORD),
  });
  return 'created';
}

/** R-54: purge rows soft-deleted more than 30 days ago. Children cascade. */
export async function purgeDeleted(db: DB, days = 30) {
  const cutoff = sql`now() - make_interval(days => ${days})`;
  const m = await db.execute(sql`delete from markers where deleted_at < ${cutoff}`);
  const f = await db.execute(sql`delete from floors where deleted_at < ${cutoff}`);
  const p = await db.execute(sql`delete from projects where deleted_at < ${cutoff}`);
  await db.execute(sql`delete from activity where at < now() - interval '365 days'`);
  await purgeExpiredSessions(db);
  return { markers: m.rowCount ?? 0, floors: f.rowCount ?? 0, projects: p.rowCount ?? 0 };
}

/** Run the purge nightly at ~03:00 server time. */
export function scheduleNightly(fn: () => Promise<unknown>, hour = 3) {
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const t = setTimeout(async () => {
      try {
        await fn();
      } finally {
        schedule();
      }
    }, next.getTime() - now.getTime());
    t.unref();
  };
  schedule();
}
