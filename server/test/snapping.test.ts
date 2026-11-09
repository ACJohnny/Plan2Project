import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLines } from '../src/lib/sheetLines';
import { login, SAMPLES, setupApp } from './helpers';

const W = 1000;
const H = 800;
function sheet(draw: (fill: (x: number, y: number, w: number, h: number) => void) => void) {
  const px = new Uint8Array(W * H).fill(255);
  draw((x, y, w, h) => {
    for (let r = y; r < y + h; r++) px.fill(0, r * W + x, r * W + x + w);
  });
  return detectLines(px, W, H);
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.003;

describe('detectLines', () => {
  it('finds thin horizontal and vertical lines, with their extents', () => {
    const l = sheet((f) => {
      f(100, 200, 500, 2);
      f(300, 100, 2, 400);
    });
    expect(l.h).toHaveLength(1);
    expect(l.v).toHaveLength(1);
    expect(near(l.h[0][0], 201 / H)).toBe(true);
    expect(near(l.h[0][1], 100 / W)).toBe(true);
    expect(near(l.h[0][2], 600 / W)).toBe(true);
    expect(near(l.v[0][0], 301 / W)).toBe(true);
  });

  it('gives both faces of a thick wall', () => {
    const l = sheet((f) => f(100, 300, 500, 8));
    expect(l.h.map((x) => x[0])).toEqual([300 / H, 308 / H]);
    expect(l.v).toHaveLength(0);
  });

  it('ignores dashes, lettering-sized strokes, and filled areas', () => {
    const l = sheet((f) => {
      for (let x = 100; x < 800; x += 12) f(x, 100, 6, 2); // dashed
      f(100, 200, 8, 2); // short stroke
      f(300, 300, 200, 200); // solid block
    });
    expect(l.h).toEqual([]);
    expect(l.v).toEqual([]);
  });

  it('treats a wall with a door gap as one line', () => {
    const l = sheet((f) => {
      f(100, 400, 200, 2);
      f(320, 400, 200, 2);
    });
    expect(l.h).toHaveLength(1);
    expect(near(l.h[0][2], 520 / W)).toBe(true);
  });

  it('keeps far-apart lines at the same height separate', () => {
    const l = sheet((f) => {
      f(10, 400, 100, 2);
      f(800, 400, 100, 2);
    });
    expect(l.h).toHaveLength(2);
  });

  it('ignores faint lines', () => {
    const px = new Uint8Array(W * H).fill(255);
    for (let x = 100; x < 600; x++) px[300 * W + x] = 200;
    expect(detectLines(px, W, H).h).toEqual([]);
  });
});

describe('snapping settings', () => {
  let env: Awaited<ReturnType<typeof setupApp>>;
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setupApp();
    admin = await login(env.app, 'admin@example.com', 'admin-password');
  });
  afterAll(async () => env?.close());

  it('has defaults, which admins alone can change', async () => {
    expect((await admin.get('/api/device-library')).json.snap).toEqual({
      cornerPx: 16,
      edgePx: 10,
      axisDeg: 3,
      linePx: 5,
    });
    const next = { cornerPx: 30, edgePx: 0, axisDeg: 4.5, linePx: 7 };
    expect((await admin.put('/api/device-library/snap', next)).json).toEqual(next);
    expect((await admin.get('/api/device-library')).json.snap).toEqual(next);
    expect((await admin.put('/api/device-library/snap', { ...next, edgePx: 2 })).status).toBe(200);
    expect((await admin.put('/api/device-library/snap', { ...next, cornerPx: 99 })).status).toBe(400);
    expect((await admin.put('/api/device-library/snap', { ...next, linePx: -1 })).status).toBe(400);
    expect((await admin.put('/api/device-library/snap', { ...next, axisDeg: 20 })).status).toBe(400);

    await admin.post('/api/users', {
      email: 'snap-ed@example.com',
      name: 'Ed',
      role: 'editor',
      password: 'editor-pass',
    });
    const ed = await login(env.app, 'snap-ed@example.com', 'editor-pass');
    expect((await ed.put('/api/device-library/snap', next)).status).toBe(403);
    expect((await ed.get('/api/device-library')).json.snap.cornerPx).toBe(30);
  });

  it('snaps to lines per project, on by default, and copies the choice', async () => {
    const p = (await admin.post('/api/projects', { name: 'Lines' })).json;
    expect(p.snapToLines).toBe(true);
    const url = `/api/projects/${p.id}`;
    expect((await admin.patch(url, { snapToLines: false })).json.snapToLines).toBe(false);
    expect((await admin.get(url)).json.project.snapToLines).toBe(false);
    const other = (await admin.post('/api/projects', { name: 'Other' })).json;
    expect(other.snapToLines).toBe(true);
    const dup = await admin.post(`${url}/duplicate`, { name: 'Copy', withMarkers: false });
    expect(dup.json.snapToLines).toBe(false);
  });

  it('finds lines on a sheet once, and keeps the result beside the image', async () => {
    const p = (await admin.post('/api/projects', { name: 'Sheet' })).json;
    await admin.upload(`/api/projects/${p.id}/uploads`, path.join(SAMPLES, 'harless-a2.1.png'));
    const floor = (await admin.get(`/api/projects/${p.id}`)).json.floors[0];
    const url = `/api/floors/${floor.id}/sheet-lines`;
    const first = await admin.get(url);
    expect(first.status).toBe(200);
    expect(first.json.h.length).toBeGreaterThan(5);
    expect(first.json.v.length).toBeGreaterThan(5);
    for (const [pos, a, b] of [...first.json.h, ...first.json.v]) {
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(1);
      expect(b).toBeGreaterThan(a);
    }
    const cached = fs.readdirSync(path.join(env.cfg.DATA_DIR, 'sheets')).filter((f) => f.endsWith('.json'));
    expect(cached).toHaveLength(1);
    const stat = fs.statSync(path.join(env.cfg.DATA_DIR, 'sheets', cached[0])).mtimeMs;
    expect((await admin.get(url)).json).toEqual(first.json);
    expect(fs.statSync(path.join(env.cfg.DATA_DIR, 'sheets', cached[0])).mtimeMs).toBe(stat);
    expect((await env.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await admin.get(`/files/sheets/${cached[0]}`)).status).toBe(404);
  });
});
