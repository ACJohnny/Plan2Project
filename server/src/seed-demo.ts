/**
 * pnpm seed:demo — creates the "Harless Residence (demo)" project from docs/samples (R-71).
 * In Docker:  docker compose exec app node server/dist/seed-demo.js
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db';
import { deviceTypes, markers, projects, users } from './db/schema';
import { Storage } from './lib/storage';
import { seedLibrary } from './routes/library';
import { bootstrapAdmin } from './services/maintenance';
import { createFloor } from './services/jobs';

const DEMO: [floor: number, code: string, x: number, y: number, room: string, notes?: string][] = [
  [0, 'DMRC', 0.08, 0.2, 'Garage', 'Demo data — fiber demarc'],
  [0, 'RACK', 0.12, 0.2, 'Garage', 'Demo data — 42U rack'],
  [0, 'WAP', 0.25, 0.55, 'Foyer'],
  [0, 'WAP', 0.55, 0.45, 'Living Room'],
  [0, 'SPK', 0.47, 0.18, 'Kitchen'],
  [0, 'SPK', 0.57, 0.18, 'Kitchen'],
  [0, 'SPK', 0.5, 0.5, 'Living Room'],
  [0, 'SPK', 0.68, 0.5, 'Living Room'],
  [0, 'SUB', 0.6, 0.62, 'Living Room'],
  [0, 'TV', 0.59, 0.72, 'Living Room', 'Demo data — 77" OLED'],
  [0, 'KPD', 0.33, 0.3, 'Foyer'],
  [0, 'CAM', 0.06, 0.08, 'Garage', 'Exterior'],
  [0, 'DBL', 0.32, 0.4, 'Foyer'],
  [0, 'OSP', 0.5, 0.86, 'Covered Patio'],
  [0, 'OSP', 0.7, 0.86, 'Covered Patio'],
  [1, 'SPK', 0.15, 0.2, 'Primary Bedroom'],
  [1, 'SPK', 0.28, 0.2, 'Primary Bedroom'],
  [1, 'TV', 0.2, 0.35, 'Primary Bedroom'],
  [1, 'WAP', 0.5, 0.48, 'Hall'],
  [1, 'TSTAT', 0.48, 0.52, 'Hall'],
  [1, 'TV', 0.7, 0.7, 'Bonus Room'],
  [1, 'SHD', 0.62, 0.12, 'Bedroom 2'],
];

async function main() {
  const cfg = loadConfig();
  const { db, pool } = createDb(cfg.DATABASE_URL);
  await runMigrations(db, cfg.MIGRATIONS_DIR);
  await seedLibrary(db);
  await bootstrapAdmin(db, cfg);
  const storage = new Storage(cfg.DATA_DIR);
  await storage.init();

  const name = 'Harless Residence (demo)';
  const existing = await db.select().from(projects).where(sql`${projects.name} = ${name} and ${projects.deletedAt} is null`);
  if (existing.length) {
    console.log(JSON.stringify({ msg: 'demo project already exists', id: existing[0].id }));
    await pool.end();
    return;
  }
  const owner = (await db.select().from(users).where(eq(users.role, 'admin')).limit(1))[0];
  const [p] = await db
    .insert(projects)
    .values({
      name,
      client: 'Harless family (demo data)',
      address: '1420 Hollow Creek Road',
      jobNumber: 'DEMO-001',
      notes: 'Demo data created by pnpm seed:demo. Safe to delete.',
      createdBy: owner?.id,
      updatedBy: owner?.id,
    })
    .returning();
  const sheets = [
    ['harless-a2.1.png', 'A2.1 1st Floor Plan', 'A2.1'],
    ['harless-a2.2.png', 'A2.2 2nd Floor Plan', 'A2.2'],
  ];
  const floorIds: string[] = [];
  for (const [file, fname, num] of sheets) {
    const s = await storage.storeSheet(path.join(cfg.SAMPLES_DIR, file));
    const f = await createFloor(db, p.id, s, fname, num, null, null);
    floorIds.push(f.id);
  }
  const types = new Map((await db.select().from(deviceTypes)).map((t) => [t.code, t.id]));
  const counters = new Map<string, number>();
  await db.insert(markers).values(
    DEMO.map(([fi, code, x, y, room, notes]) => {
      const n = (counters.get(code) ?? 0) + 1;
      counters.set(code, n);
      return {
        id: randomUUID(),
        projectId: p.id,
        floorId: floorIds[fi],
        typeId: types.get(code)!,
        number: n,
        x,
        y,
        room,
        notes: notes ?? '',
        createdBy: owner?.id,
        updatedBy: owner?.id,
      };
    }),
  );
  console.log(JSON.stringify({ msg: 'demo project created', id: p.id, markers: DEMO.length }));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
