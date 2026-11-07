import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, login, ORIGIN, SAMPLES, setupApp } from './helpers';

let env: Awaited<ReturnType<typeof setupApp>>;
let admin: Awaited<ReturnType<typeof login>>;
let editor: Awaited<ReturnType<typeof login>>;
let viewer: Awaited<ReturnType<typeof login>>;
let lib: any;
const typeId = (code: string) => lib.types.find((t: any) => t.code === code).id;

beforeAll(async () => {
  env = await setupApp();
  admin = await login(env.app, 'admin@example.com', 'admin-password');
  lib = (await admin.get('/api/device-library')).json;
});
afterAll(async () => env?.close());

describe('health and auth (R-6, R-10..R-14)', () => {
  it('healthz answers', async () => {
    const r = await env.app.inject({ url: '/healthz' });
    expect(r.statusCode).toBe(200);
  });

  it('seeds 22 device types in 6 categories', () => {
    expect(lib.categories).toHaveLength(6);
    expect(lib.types).toHaveLength(22);
    expect(lib.types[0].code).toBe('SPK');
  });

  it('rejects unauthenticated requests', async () => {
    const r = await env.app.inject({ url: '/api/projects' });
    expect(r.statusCode).toBe(401);
  });

  it('sets an httpOnly SameSite=Lax session cookie', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'admin@example.com', password: 'admin-password' },
    });
    const c = r.cookies.find((x) => x.name === 'sp_sid')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.maxAge).toBe(30 * 24 * 3600);
  });

  it('admin creates an editor and a viewer', async () => {
    const e = await admin.post('/api/users', {
      email: 'ed@example.com',
      name: 'Ed Itor',
      role: 'editor',
      password: 'editor-pass',
    });
    expect(e.status).toBe(200);
    const v = await admin.post('/api/users', {
      email: 'vi@example.com',
      name: 'Vi Ewer',
      role: 'viewer',
      password: 'viewer-pass',
    });
    expect(v.status).toBe(200);
    expect(
      (
        await admin.post('/api/users', {
          email: 'ED@example.com',
          name: 'x',
          role: 'viewer',
          password: 'whatever1',
        })
      ).status,
    ).toBe(409);
    editor = await login(env.app, 'ed@example.com', 'editor-pass');
    viewer = await login(env.app, 'vi@example.com', 'viewer-pass');
  });

  it('enforces roles on the server', async () => {
    expect((await editor.get('/api/users')).status).toBe(403);
    expect((await viewer.post('/api/projects', { name: 'Nope' })).status).toBe(403);
    expect((await viewer.get('/api/projects')).status).toBe(200);
  });

  it('blocks cross-origin state changes (CSRF)', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: editor.cookie, origin: 'https://evil.example' },
      payload: { name: 'x' },
    });
    expect(r.statusCode).toBe(403);
    const r2 = await env.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: editor.cookie },
      payload: { name: 'x' },
    });
    expect(r2.statusCode).toBe(403);
  });

  it('users change their own name and password (R-12)', async () => {
    const r = await viewer.patch('/api/me', { name: 'Vi Ewer II', theme: 'dark' });
    expect(r.json.user.name).toBe('Vi Ewer II');
    expect(r.json.user.theme).toBe('dark');
    expect(
      (await viewer.patch('/api/me', { currentPassword: 'wrong', newPassword: 'newpass123' })).status,
    ).toBe(400);
  });

  it('locks sign-in after 10 failures per email', async () => {
    await admin.post('/api/users', {
      email: 'lock@example.com',
      name: 'Lock',
      role: 'viewer',
      password: 'right-pass',
    });
    for (let i = 0; i < 10; i++) {
      const r = await env.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ORIGIN, 'x-forwarded-for': `10.0.0.${i}` },
        payload: { email: 'lock@example.com', password: 'bad' },
      });
      expect(r.statusCode).toBe(401);
    }
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, 'x-forwarded-for': '10.0.1.1' },
      payload: { email: 'lock@example.com', password: 'right-pass' },
    });
    expect(r.statusCode).toBe(429);
  });

  it('deactivated users are signed out', async () => {
    const u = await admin.post('/api/users', {
      email: 'gone@example.com',
      name: 'Gone',
      role: 'editor',
      password: 'gone-pass1',
    });
    const c = await login(env.app, 'gone@example.com', 'gone-pass1');
    await admin.patch(`/api/users/${u.json.id}`, { active: false });
    expect((await c.get('/api/me')).status).toBe(401);
  });
});

describe('projects, uploads and markers', () => {
  let projectId: string;
  let floors: any[];

  it('creates and lists projects with search (R-15, R-16)', async () => {
    const p = await editor.post('/api/projects', {
      name: 'Harless Residence',
      client: 'Harless',
      address: '1420 Hollow Creek Road',
    });
    expect(p.status).toBe(200);
    projectId = p.json.id;
    await editor.post('/api/projects', { name: 'Other Job', client: 'Smith' });
    const list = await viewer.get('/api/projects?q=hollow');
    expect(list.json.map((x: any) => x.name)).toEqual(['Harless Residence']);
    expect(list.json[0].updatedByName).toBe('Ed Itor');
  });

  it('converts the 2-page PDF into two floors named from sheet titles (R-18, R-19)', async () => {
    const r = await editor.upload(
      `/api/projects/${projectId}/uploads`,
      path.join(SAMPLES, 'harless-plans.pdf'),
    );
    expect(r.status).toBe(200);
    await env.app.ctx.jobs.idle();
    const up = (await editor.get(`/api/uploads/${r.json.id}`)).json;
    expect(up.status).toBe('done');
    expect(up.pageCount).toBe(2);
    const proj = (await editor.get(`/api/projects/${projectId}`)).json;
    floors = proj.floors;
    expect(floors.map((f: any) => f.name)).toEqual(['A2.1 1st Floor Plan', 'A2.2 2nd Floor Plan']);
    expect(floors.map((f: any) => f.sheetNumber)).toEqual(['A2.1', 'A2.2']);
    expect(floors[0].widthPx).toBe(5400);
    expect(floors[0].heightPx).toBe(3600);
    // the files are served to signed-in users only, with long cache headers
    const img = await env.app.inject({ url: floors[0].thumbUrl, headers: { cookie: editor.cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['cache-control']).toContain('immutable');
    expect((await env.app.inject({ url: floors[0].thumbUrl })).statusCode).toBe(401);
    const meta = await sharp(img.rawPayload).metadata();
    expect(meta.width).toBe(600);
  });

  it('rejects files by magic bytes, not extension (R-68)', async () => {
    const fake = path.join(os.tmpdir(), 'fake.pdf');
    fs.writeFileSync(fake, 'not really a pdf');
    const r = await editor.upload(`/api/projects/${projectId}/uploads`, fake);
    expect(r.status).toBe(415);
  });

  const place = (c: typeof editor, floorId: string, code: string, x = 0.5, y = 0.5, id = randomUUID()) =>
    c.put(`/api/markers/${id}`, { projectId, floorId, typeId: typeId(code), x, y });

  it('numbers per type across floors (R-29)', async () => {
    const tags: number[] = [];
    for (let i = 0; i < 3; i++)
      tags.push((await place(editor, floors[0].id, 'SPK', 0.1 * (i + 1), 0.2)).json.number);
    for (let i = 0; i < 2; i++)
      tags.push((await place(editor, floors[1].id, 'SPK', 0.1 * (i + 1), 0.3)).json.number);
    expect(tags).toEqual([1, 2, 3, 4, 5]);
    expect((await place(editor, floors[0].id, 'TV')).json.number).toBe(1);
  });

  it('never hands out the same number to concurrent placements', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => place(editor, floors[0].id, 'CAM')));
    const nums = results.map((r) => r.json.number).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('upserts by client id, rejects writes to deleted markers, restores on undo (R-37, R-52)', async () => {
    const id = randomUUID();
    const m = (await place(editor, floors[0].id, 'KPD', 0.4, 0.4, id)).json;
    const upd = await editor.put(`/api/markers/${id}`, {
      projectId,
      floorId: floors[0].id,
      typeId: typeId('KPD'),
      number: m.number,
      x: 0.123456789,
      y: 0.4,
      room: 'Kitchen',
      notes: 'by the door',
    });
    expect(upd.json.x).toBe(0.12346);
    expect(upd.json.room).toBe('Kitchen');
    expect((await viewer.del(`/api/markers/${id}`)).status).toBe(403);
    expect((await editor.del(`/api/markers/${id}`)).status).toBe(200);
    const stale = await editor.put(`/api/markers/${id}`, {
      projectId,
      floorId: floors[0].id,
      typeId: typeId('KPD'),
      x: 0.5,
      y: 0.5,
    });
    expect(stale.status).toBe(410);
    const restored = await editor.put(`/api/markers/${id}`, {
      projectId,
      floorId: floors[0].id,
      typeId: typeId('KPD'),
      number: m.number,
      x: 0.12346,
      y: 0.4,
      room: 'Kitchen',
      notes: 'by the door',
      restore: true,
    });
    expect(restored.status).toBe(200);
    expect(restored.json.id).toBe(id);
    expect(restored.json.number).toBe(m.number);
  });

  it('assigns the next number when the type changes (R-41)', async () => {
    const id = randomUUID();
    await place(editor, floors[0].id, 'TV', 0.6, 0.6, id);
    const r = await editor.patch('/api/markers/batch', {
      projectId,
      updates: [{ id, typeId: typeId('SPK'), autoNumber: true }],
    });
    expect(r.json.markers[0].number).toBe(6);
  });

  it('batch moves and deletes', async () => {
    const all = (await editor.get(`/api/projects/${projectId}/markers`)).json;
    const cams = all.filter((m: any) => m.typeId === typeId('CAM'));
    const r = await editor.patch('/api/markers/batch', {
      projectId,
      updates: cams.slice(0, 2).map((m: any) => ({ id: m.id, x: 0.9, y: 0.9 })),
      deletes: [cams[7].id],
    });
    expect(r.json.markers.every((m: any) => m.x === 0.9)).toBe(true);
    expect(r.json.deleted).toEqual([cams[7].id]);
  });

  it('previews and applies renumbering (R-30)', async () => {
    const preview = await editor.post(`/api/projects/${projectId}/renumber`, {
      typeId: typeId('SPK'),
      apply: false,
    });
    expect(preview.json.applied).toBe(false);
    const ms = (await editor.get(`/api/projects/${projectId}/markers`)).json;
    expect(
      ms
        .filter((m: any) => m.typeId === typeId('SPK'))
        .map((m: any) => m.number)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    const applied = await editor.post(`/api/projects/${projectId}/renumber`, { typeId: null, apply: true });
    expect(applied.json.applied).toBe(true);
    const cams = (await editor.get(`/api/projects/${projectId}/markers`)).json
      .filter((m: any) => m.typeId === typeId('CAM'))
      .map((m: any) => m.number)
      .sort((a: number, b: number) => a - b);
    expect(cams).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('records activity (R-55)', async () => {
    const a = (await viewer.get(`/api/projects/${projectId}/activity`)).json;
    expect(a.length).toBeGreaterThan(5);
    expect(a.length).toBeLessThanOrEqual(50);
    expect(a.some((x: any) => x.action === 'renumber')).toBe(true);
    expect(a.some((x: any) => x.summary.startsWith('Deleted'))).toBe(true);
  });

  it('exports CSV with BOM, plain text and PDF to any role (R-56..R-59)', async () => {
    const csv = await viewer.get(`/api/projects/${projectId}/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body.slice(1).split('\r\n')[0]).toBe(
      'floor,sheet,tag,code,type,category,number,room,mount_height,notes,x,y',
    );
    expect(csv.headers['content-disposition']).toMatch(
      /harless-residence-device-plan-\d{4}-\d{2}-\d{2}\.csv/,
    );
    const txt = await viewer.get(`/api/projects/${projectId}/export.txt`);
    expect(txt.body).toContain('A2.1 1st Floor Plan');
    const pdf = await viewer.get(`/api/projects/${projectId}/export.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.subarray(0, 5).toString()).toBe('%PDF-');
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf.raw);
    const sizes = doc.getPages().map((p) => {
      const s = p.getSize();
      return `${s.width}x${s.height}`;
    });
    expect(sizes.slice(0, 2)).toEqual(['1224x792', '1224x792']);
    expect(sizes.slice(2).every((s) => s === '612x792')).toBe(true);
    expect(sizes.length).toBeGreaterThanOrEqual(4);
    const one = await viewer.get(`/api/projects/${projectId}/export.pdf?floors=${floors[1].id}`);
    const doc1 = await PDFDocument.load(one.raw);
    expect(doc1.getPage(0).getSize().width).toBe(1224);
    expect(doc1.getPage(1).getSize().width).toBe(612);
  });

  it('replaces a sheet keeping fractional positions, warning on aspect change (R-22)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-'));
    const same = path.join(tmp, 'rerender.png');
    await sharp(path.join(SAMPLES, 'harless-a2.1.png')).resize({ width: 2700 }).png().toFile(same);
    const before = (await editor.get(`/api/projects/${projectId}/markers?floorId=${floors[0].id}`)).json;
    const r = await editor.upload(`/api/floors/${floors[0].id}/sheet`, same);
    expect(r.json.applied).toBe(true);
    expect(r.json.floor.widthPx).toBe(2700);
    const after = (await editor.get(`/api/projects/${projectId}/markers?floorId=${floors[0].id}`)).json;
    expect(after.map((m: any) => [m.id, m.x, m.y]).sort()).toEqual(
      before.map((m: any) => [m.id, m.x, m.y]).sort(),
    );
    const square = path.join(tmp, 'square.png');
    await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#fff' } })
      .png()
      .toFile(square);
    const w = await editor.upload(`/api/floors/${floors[0].id}/sheet`, square);
    expect(w.json.applied).toBe(false);
    expect(w.json.aspectDiff).toBeGreaterThan(0.02);
    const c = await editor.post(`/api/floors/${floors[0].id}/sheet?staged=${w.json.stagedId}&confirm=true`);
    expect(c.json.applied).toBe(true);
    expect((await editor.get(`/api/floors/${floors[0].id}/revisions`)).json).toHaveLength(2);
  });

  it('renames, reorders and deletes floors (R-21)', async () => {
    await editor.patch(`/api/floors/${floors[1].id}`, { name: 'Upstairs', sheetNumber: 'A2.2' });
    const order = await editor.post(`/api/projects/${projectId}/floors/reorder`, {
      floorIds: [floors[1].id, floors[0].id],
    });
    expect(order.json.map((f: any) => f.name)[0]).toBe('Upstairs');
    const count = (await editor.get(`/api/floors/${floors[1].id}/marker-count`)).json.count;
    const d = await editor.del(`/api/floors/${floors[1].id}`);
    expect(d.json.markersRemoved).toBe(count);
  });

  it('duplicates with and without markers (R-23)', async () => {
    const withM = await editor.post(`/api/projects/${projectId}/duplicate`, {
      name: 'Harless copy',
      withMarkers: true,
    });
    expect(withM.json.floorCount).toBe(1);
    expect(withM.json.deviceCount).toBeGreaterThan(0);
    const without = await editor.post(`/api/projects/${projectId}/duplicate`, {
      name: 'Harless template',
      withMarkers: false,
    });
    expect(without.json.deviceCount).toBe(0);
  });

  it('archives, soft-deletes and restores projects (R-15, R-54)', async () => {
    const p = (await editor.post('/api/projects', { name: 'Temp' })).json;
    await editor.patch(`/api/projects/${p.id}`, { archived: true });
    expect((await editor.get('/api/projects')).json.some((x: any) => x.id === p.id)).toBe(false);
    expect((await editor.get('/api/projects?view=archived')).json.some((x: any) => x.id === p.id)).toBe(true);
    expect((await editor.del(`/api/projects/${p.id}`)).status).toBe(403);
    expect((await admin.del(`/api/projects/${p.id}`)).status).toBe(200);
    expect((await admin.get('/api/projects?view=trash')).json.some((x: any) => x.id === p.id)).toBe(true);
    expect((await admin.patch(`/api/projects/${p.id}`, { restore: true })).status).toBe(200);
  });
});

describe('device library (R-24..R-26)', () => {
  it('validates codes and uniqueness', async () => {
    const cat = lib.categories[0].id;
    expect(
      (await admin.post('/api/device-library/types', { categoryId: cat, code: 'spk', name: 'x' })).status,
    ).toBe(400);
    expect(
      (await admin.post('/api/device-library/types', { categoryId: cat, code: 'SPK', name: 'x' })).status,
    ).toBe(409);
    expect(
      (await editor.post('/api/device-library/types', { categoryId: cat, code: 'AMP', name: 'Amp' })).status,
    ).toBe(403);
    const t = await admin.post('/api/device-library/types', {
      categoryId: cat,
      code: 'AMP',
      name: 'Amplifier',
      defaultModel: 'XYZ-1',
    });
    expect(t.status).toBe(200);
    expect((await admin.del(`/api/device-library/types/${t.json.id}`)).status).toBe(200);
  });

  it('retires used types instead of deleting them', async () => {
    const spk = lib.types.find((t: any) => t.code === 'SPK').id;
    expect((await admin.del(`/api/device-library/types/${spk}`)).status).toBe(409);
    const r = await admin.patch(`/api/device-library/types/${spk}`, { retired: true });
    expect(r.json.retiredAt).not.toBeNull();
    await admin.patch(`/api/device-library/types/${spk}`, { retired: false });
  });
});

describe('API tokens', () => {
  it('reads with a bearer token, cannot write', async () => {
    const t = await admin.post('/api/tokens', { name: 'script' });
    const auth = { authorization: `Bearer ${t.json.token}` };
    const list = await env.app.inject({ url: '/api/projects', headers: auth });
    expect(list.statusCode).toBe(200);
    const w = await env.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: auth,
      payload: { name: 'x' },
    });
    expect(w.statusCode).toBe(403);
    await admin.del(`/api/tokens/${t.json.id}`);
    expect((await env.app.inject({ url: '/api/projects', headers: auth })).statusCode).toBe(401);
  });

  it('serves the OpenAPI document', async () => {
    const r = await env.app.inject({ url: '/api/docs/json' });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json().paths)).toContain('/api/markers/{id}');
  });
});

void client;
