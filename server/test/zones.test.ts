import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, SAMPLES, setupApp } from './helpers';

let env: Awaited<ReturnType<typeof setupApp>>;
let admin: Awaited<ReturnType<typeof login>>;
let lib: any;
let projectId: string;
let floors: any[];
const typeId = (code: string) => lib.types.find((t: any) => t.code === code).id;
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

beforeAll(async () => {
  env = await setupApp();
  admin = await login(env.app, 'admin@example.com', 'admin-password');
  lib = (await admin.get('/api/device-library')).json;
  projectId = (await admin.post('/api/projects', { name: 'Zones' })).json.id;
  for (const f of ['harless-a2.1.png', 'harless-a2.2.png'])
    await admin.upload(`/api/projects/${projectId}/uploads`, path.join(SAMPLES, f));
  floors = (await admin.get(`/api/projects/${projectId}`)).json.floors;
});
afterAll(async () => env?.close());

describe('wire library', () => {
  it('seeds wire types and default wiring per device type', () => {
    expect(lib.wireTypes.map((w: any) => w.name)).toContain('Cat6');
    const tv = lib.types.find((t: any) => t.code === 'TV');
    const names = tv.wires.map((w: any) => [
      lib.wireTypes.find((x: any) => x.id === w.wireTypeId).name,
      w.count,
    ]);
    expect(names).toEqual([
      ['Cat6', 2],
      ['RG6 coax', 1],
    ]);
  });

  it('admins edit wire types and a type’s wires', async () => {
    const w = await admin.post('/api/device-library/wire-types', { name: 'HDMI' });
    expect(w.status).toBe(200);
    const r = await admin.patch(`/api/device-library/types/${typeId('PRJ')}`, {
      wires: [
        { wireTypeId: w.json.id, count: 1 },
        { wireTypeId: lib.wireTypes[0].id, count: 2 },
      ],
    });
    expect(r.json.wires).toHaveLength(2);
    expect((await admin.post('/api/device-library/wire-types', { name: 'HDMI' })).status).toBe(409);
  });
});

describe('zone names', () => {
  it('seeds a default list that admins can add to, rename, reorder and delete', async () => {
    const names = lib.zoneNames.map((z: any) => z.name);
    expect(names).toContain('Living Room');
    expect(names).toContain('Equipment Closet');
    const add = await admin.post('/api/device-library/zone-names', { name: 'Sunroom' });
    expect(add.status).toBe(200);
    expect((await admin.post('/api/device-library/zone-names', { name: 'sunroom' })).status).toBe(409);
    const ren = await admin.patch(`/api/device-library/zone-names/${add.json.id}`, { name: 'Sun Room' });
    expect(ren.json.name).toBe('Sun Room');
    let l = (await admin.get('/api/device-library')).json;
    const ids = l.zoneNames.map((z: any) => z.id);
    await admin.post('/api/device-library/zone-names/reorder', {
      ids: [add.json.id, ...ids.filter((i: string) => i !== add.json.id)],
    });
    l = (await admin.get('/api/device-library')).json;
    expect(l.zoneNames[0].name).toBe('Sun Room');
    await admin.del(`/api/device-library/zone-names/${add.json.id}`);
    l = (await admin.get('/api/device-library')).json;
    expect(l.zoneNames.map((z: any) => z.name)).not.toContain('Sun Room');
  });

  it('only admins change the list', async () => {
    await admin.post('/api/users', {
      email: 'zn-ed@example.com',
      name: 'Ed',
      role: 'editor',
      password: 'editor-pass',
    });
    const ed = await login(env.app, 'zn-ed@example.com', 'editor-pass');
    expect((await ed.post('/api/device-library/zone-names', { name: 'Nope' })).status).toBe(403);
    expect((await ed.get('/api/device-library')).json.zoneNames.length).toBeGreaterThan(10);
  });
});

describe('zones, scale and runs', () => {
  let closetId: string;
  let closet2Id: string;
  let spk: string;
  let up: string;

  it('creates rooms and equipment closets', async () => {
    closetId = randomUUID();
    const c = await admin.put(`/api/zones/${closetId}`, {
      projectId,
      floorId: floors[0].id,
      name: 'Mech room',
      kind: 'closet',
      points: rect(0, 0, 0.2, 0.2),
    });
    expect(c.status).toBe(200);
    const room = await admin.put(`/api/zones/${randomUUID()}`, {
      projectId,
      floorId: floors[0].id,
      name: 'Living Room',
      kind: 'room',
      points: rect(0.4, 0.4, 0.8, 0.8),
      audioFormat: '5.1',
    });
    expect(room.json.audioFormat).toBe('5.1');
    expect((await admin.get(`/api/projects/${projectId}/zones`)).json).toHaveLength(2);
  });

  it('reports what is missing before scale and risers are set', async () => {
    spk = randomUUID();
    await admin.put(`/api/markers/${spk}`, {
      projectId,
      floorId: floors[0].id,
      typeId: typeId('SPK'),
      x: 0.6,
      y: 0.6,
    });
    const s = (await admin.get(`/api/projects/${projectId}/summary`)).json;
    expect(s.runs.find((r: any) => r.markerId === spk).reason).toMatch(/Set the scale/);
  });

  it('computes right-angle runs with the project extra length', async () => {
    // 5400 px wide sheet; 0.02 ft/px → 108 ft × 72 ft
    for (const f of floors) await admin.patch(`/api/floors/${f.id}`, { ftPerPx: 0.02, floorHeightFt: 10 });
    await admin.patch(`/api/projects/${projectId}`, { extraWireFt: 10 });
    const s = (await admin.get(`/api/projects/${projectId}/summary`)).json;
    const r = s.runs.find((x: any) => x.markerId === spk);
    // device (0.6,0.6) → closet centroid (0.1,0.1): 0.5×108 + 0.5×72 = 90 ft + 10 extra
    expect(r.lengthFt).toBeCloseTo(100, 5);
    expect(r.closetZoneId).toBe(closetId);
    const speakerWire = s.wires.find((w: any) => w.name === '16/2 speaker');
    expect(speakerWire.totalFt).toBeCloseTo(100, 5);
    expect(s.audioZones).toEqual([
      { format: '5.1', label: '5.1', zones: [expect.objectContaining({ name: 'Living Room', devices: 1 })] },
    ]);
  });

  it('routes other floors through riser points, and honors a closet override', async () => {
    up = randomUUID();
    await admin.put(`/api/markers/${up}`, {
      projectId,
      floorId: floors[1].id,
      typeId: typeId('WAP'),
      x: 0.5,
      y: 0.5,
    });
    let s = (await admin.get(`/api/projects/${projectId}/summary`)).json;
    expect(s.runs.find((r: any) => r.markerId === up).reason).toMatch(/Set a riser/);
    await admin.patch(`/api/floors/${floors[0].id}`, { riserX: 0.1, riserY: 0.5 });
    await admin.patch(`/api/floors/${floors[1].id}`, { riserX: 0.5, riserY: 0.1 });
    s = (await admin.get(`/api/projects/${projectId}/summary`)).json;
    // upstairs (0.5,0.5)→riser (0.5,0.1): 0.4×72 = 28.8; +10 vertical; downstairs riser (0.1,0.5)→closet (0.1,0.1): 28.8; +10 extra
    expect(s.runs.find((r: any) => r.markerId === up).lengthFt).toBeCloseTo(77.6, 5);

    closet2Id = randomUUID();
    await admin.put(`/api/zones/${closet2Id}`, {
      projectId,
      floorId: floors[1].id,
      name: 'Upstairs IDF',
      kind: 'closet',
      points: rect(0.4, 0.4, 0.6, 0.6),
    });
    const r = await admin.patch('/api/markers/batch', {
      projectId,
      updates: [{ id: up, closetZoneId: closet2Id }],
    });
    expect(r.json.markers[0].closetZoneId).toBe(closet2Id);
    s = (await admin.get(`/api/projects/${projectId}/summary`)).json;
    expect(s.runs.find((x: any) => x.markerId === up).lengthFt).toBeCloseTo(10, 5); // at the closet centroid
  });

  it('deleting a closet sends its devices back to the default closet', async () => {
    await admin.del(`/api/zones/${closet2Id}`);
    const ms = (await admin.get(`/api/projects/${projectId}/markers`)).json;
    expect(ms.find((m: any) => m.id === up).closetZoneId).toBeNull();
  });

  it('exports zone, closet, wires and run length in the CSV, and a summary page in the PDF', async () => {
    const csv = (await admin.get(`/api/projects/${projectId}/export.csv`)).body;
    const line = csv.split('\r\n').find((l) => l.includes(',SPK1,'))!;
    expect(line.endsWith(',Living Room,Mech room,1× 16/2 speaker,100')).toBe(true);
    const pdf = await admin.get(`/api/projects/${projectId}/export.pdf`);
    expect(pdf.status).toBe(200);
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf.raw);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(5); // 2 floors + schedule + totals + summary
  });

  it('keeps the real-world scale when a sheet is replaced at another resolution', async () => {
    const sharp = (await import('sharp')).default;
    const half = path.join(env.cfg.DATA_DIR, 'half.png');
    await sharp(path.join(SAMPLES, 'harless-a2.1.png')).resize({ width: 2700 }).png().toFile(half);
    const r = await admin.upload(`/api/floors/${floors[0].id}/sheet`, half);
    expect(r.json.floor.ftPerPx).toBeCloseTo(0.04, 8);
  });

  it('duplicates zones with the project', async () => {
    const d = await admin.post(`/api/projects/${projectId}/duplicate`, {
      name: 'Zones copy',
      withMarkers: true,
    });
    expect((await admin.get(`/api/projects/${d.json.id}/zones`)).json).toHaveLength(2);
    expect(d.json.extraWireFt).toBe(10);
  });
});
