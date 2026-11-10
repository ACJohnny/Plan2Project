import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { polygonArea } from '@sixpoint/shared';
import {
  findRooms,
  roomLabels,
  scaleFromText,
  squareUp,
  tidyName,
  traceOutline,
  type PageText,
  type TextBlock,
} from '../src/lib/rooms';
import { detectLines } from '../src/lib/sheetLines';
import { login, SAMPLES, setupApp } from './helpers';

/* ---------- synthetic drawings ---------- */

const W = 1000;
const H = 700;
/** 10 px to the foot */
const PX_PER_FT = 10;

function drawing(draw: (wall: (x: number, y: number, w: number, h: number) => void) => void) {
  const grey = new Uint8Array(W * H).fill(255);
  draw((x, y, w, h) => {
    for (let r = y; r < y + h; r++) grey.fill(0, r * W + x, r * W + x + w);
  });
  return grey;
}

/** Two rooms side by side, 6 px walls, a 25 px (2.5 ft) door between them and one to the outside. */
const twoRooms = () =>
  drawing((wall) => {
    wall(100, 100, 800, 6); // top
    wall(100, 594, 800, 6); // bottom
    wall(100, 100, 6, 500); // left
    wall(894, 100, 6, 500); // right
    wall(500, 100, 6, 200); // middle, door gap 300..325
    wall(500, 325, 6, 275);
  });

const label = (name: string, x: number, y: number) => ({ name, x: x / W, y: y / H });
const bbox = (pts: [number, number][]) => {
  const xs = pts.map((p) => p[0] * W);
  const ys = pts.map((p) => p[1] * H);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round);
};

describe('findRooms', () => {
  it('outlines each labelled room up to its walls, sealing the door between them', async () => {
    const grey = twoRooms();
    const rooms = await findRooms({
      grey,
      width: W,
      height: H,
      labels: [label('A', 300, 350), label('B', 700, 350)],
      erase: [],
      lines: detectLines(grey, W, H),
      pxPerFt: PX_PER_FT,
    });
    expect(rooms.map((r) => r.label)).toEqual([0, 1]);
    for (const r of rooms) expect(r.points).toHaveLength(4);
    const [a, b] = rooms.map((r) => bbox(r.points));
    // the inner faces of the walls, to within a few inches
    for (const [got, want] of [
      [a, [106, 106, 500, 594]],
      [b, [506, 106, 894, 594]],
    ])
      got.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThanOrEqual(4));
  });

  it('splits an open space between the labels in it', async () => {
    const grey = drawing((wall) => {
      wall(100, 100, 800, 6);
      wall(100, 594, 800, 6);
      wall(100, 100, 6, 500);
      wall(894, 100, 6, 500);
    });
    const rooms = await findRooms({
      grey,
      width: W,
      height: H,
      labels: [label('Kitchen', 250, 350), label('Family', 750, 350)],
      erase: [],
      pxPerFt: PX_PER_FT,
    });
    expect(rooms).toHaveLength(2);
    const [a, b] = rooms.map((r) => bbox(r.points));
    expect(Math.abs(a[2] - 500)).toBeLessThan(5);
    expect(Math.abs(b[0] - 500)).toBeLessThan(5);
  });

  it('skips labels outside the walls and labels in a room that leaks', async () => {
    const grey = drawing((wall) => {
      wall(100, 100, 400, 6);
      wall(100, 400, 400, 6);
      wall(100, 100, 6, 306);
      wall(494, 100, 6, 150); // a 150 px (15 ft) opening on the right: open to the outside
      // a word drawn across the room's label spot
      wall(280, 245, 40, 10);
    });
    const rooms = await findRooms({
      grey,
      width: W,
      height: H,
      labels: [label('Inside', 300, 250), label('Outside', 800, 600)],
      erase: [[270 / W, 240 / H, 330 / W, 260 / H]],
      pxPerFt: PX_PER_FT,
    });
    expect(rooms).toEqual([]);
  });

  it('ignores dashed lines and keeps a door swing from cutting into the room', async () => {
    const grey = drawing((wall) => {
      wall(100, 100, 400, 3); // top
      wall(100, 397, 400, 3); // bottom
      wall(100, 100, 3, 300); // left
      wall(497, 100, 3, 120); // right, with a 30 px (3 ft) door at 220..250
      wall(497, 250, 3, 150);
      // a dashed line across the room (overhead cabinets, a beam)
      for (let x = 110; x < 490; x += 12) wall(x, 250, 6, 2);
    });
    // the door swing: a quarter circle hinged at the lower jamb, swinging into the room
    for (let a = 0; a <= 90; a += 0.5) {
      const t = (a * Math.PI) / 180;
      const x = Math.round(497 - 30 * Math.sin(t));
      const y = Math.round(250 - 30 * Math.cos(t));
      grey[y * W + x] = 0;
    }
    for (let x = 467; x < 497; x++) grey[250 * W + x] = 0; // the leaf, open
    const rooms = await findRooms({
      grey,
      width: W,
      height: H,
      labels: [label('Den', 300, 200)],
      erase: [],
      pxPerFt: PX_PER_FT,
    });
    expect(rooms).toHaveLength(1);
    // the whole room, a plain rectangle: not split at the dashes, not notched at the door
    expect(rooms[0].points).toHaveLength(4);
    const b = bbox(rooms[0].points);
    [103, 103, 497, 397].forEach((v, i) => expect(Math.abs(b[i] - v)).toBeLessThanOrEqual(4));
  });

  it('treats the space inside a sheet border as outside', async () => {
    const grey = drawing((wall) => {
      // sheet border
      wall(5, 5, 990, 3);
      wall(5, 692, 990, 3);
      wall(5, 5, 3, 690);
      wall(992, 5, 3, 690);
      // one closed room
      wall(300, 200, 300, 6);
      wall(300, 500, 300, 6);
      wall(300, 200, 6, 306);
      wall(594, 200, 6, 306);
    });
    const rooms = await findRooms({
      grey,
      width: W,
      height: H,
      labels: [label('Room', 450, 350), label('Yard', 150, 600)],
      erase: [],
      pxPerFt: PX_PER_FT,
    });
    expect(rooms.map((r) => r.label)).toEqual([0]);
  });
});

describe('outlines', () => {
  it('traces a region clockwise along pixel edges', () => {
    const m = new Uint8Array(6 * 5);
    for (let y = 1; y <= 3; y++) for (let x = 2; x <= 4; x++) m[y * 6 + x] = 1;
    expect(traceOutline(m, 6, 5)).toEqual([
      [2, 1],
      [5, 1],
      [5, 4],
      [2, 4],
    ]);
  });

  it('squares up nearly straight edges and keeps slanted ones', () => {
    const sq = squareUp([
      [0, 0],
      [100, 3],
      [102, 100],
      [50, 150],
      [-2, 101],
    ]);
    expect(sq[0]).toEqual([-1, 1.5]);
    expect(sq[1]).toEqual([101, 1.5]);
    expect(sq[2]).toEqual([101, 100]);
    expect(sq[3]).toEqual([50, 150]);
    expect(sq[4]).toEqual([-1, 101]);
  });
});

/* ---------- text ---------- */

const block = (lines: string[], x = 0.5, y = 0.5, size = 0.01): TextBlock => ({
  lines,
  box: [x - 0.02, y - 0.01, x + 0.02, y + 0.01],
  words: [[x - 0.02, y - size / 2, x + 0.02, y + size / 2]],
});
const page = (blocks: TextBlock[]): PageText => ({ width: 2592, height: 1728, blocks });

describe('room labels', () => {
  it('keeps room names and drops dimensions, notes, tags and titles', () => {
    const t = page([
      block(['PRIMARY', 'BEDROOM']),
      block(['BEDROOM 2', '13\'-7" x 18\'-2"']),
      block(['W.I.C.']),
      block(['14\' 6"']),
      block(["99.01'", 'F.F.']),
      block(['UP']),
      block(['A', 'A3.1']),
      block(['P R O J E C T']),
      block(['PROPOSED', 'ADDITION']),
      block(['1ST FLOOR PLAN']),
      block(['HARLESS RESIDENCE'], 0.9, 0.1, 0.03),
      block(['KITCHEN']),
      block(['Plan Check Number']),
    ]);
    expect(roomLabels(t).map((l) => l.name)).toEqual(['PRIMARY BEDROOM', 'BEDROOM 2', 'W.I.C.', 'KITCHEN']);
  });

  it('tidies names, expanding common abbreviations and matching known spellings', () => {
    expect(tidyName('PRIMARY BEDROOM')).toBe('Primary Bedroom');
    expect(tidyName('CLO')).toBe('Closet');
    expect(tidyName('W.I.C.')).toBe('Walk-in Closet');
    expect(tidyName('BATH 2')).toBe('Bath 2');
    expect(tidyName('WALK-IN CLOSET')).toBe('Walk-in Closet');
    expect(tidyName('MEDIA ROOM', ['Media room'])).toBe('Media room');
  });

  it('reads the drawing scale from the text', () => {
    expect(scaleFromText(page([block(['SCALE: 1/4" = 1\'-0"'])]))).toBe(4);
    expect(scaleFromText(page([block(['SCALE 1/8" = 1\'-0"'])]))).toBe(8);
    expect(scaleFromText(page([block(['KITCHEN'])]))).toBeNull();
  });
});

/* ---------- API ---------- */

describe('POST /api/floors/:id/detect-rooms', () => {
  let env: Awaited<ReturnType<typeof setupApp>>;
  let admin: Awaited<ReturnType<typeof login>>;
  let projectId: string;

  beforeAll(async () => {
    env = await setupApp();
    admin = await login(env.app, 'admin@example.com', 'admin-password');
    projectId = (await admin.post('/api/projects', { name: 'Rooms' })).json.id;
  });
  afterAll(async () => env?.close());

  it('names and outlines the rooms on a PDF sheet', async () => {
    await admin.upload(`/api/projects/${projectId}/uploads`, path.join(SAMPLES, 'harless-plans.pdf'));
    await env.app.ctx.jobs.idle();
    const floors = (await admin.get(`/api/projects/${projectId}`)).json.floors;
    const f = floors.find((x: any) => x.sheetNumber === 'A2.1');
    // the placeholder sheet's own scale: its 14 ft garage is about 1030 px wide
    await admin.patch(`/api/floors/${f.id}`, { ftPerPx: 0.0136 });
    const r = await admin.post(`/api/floors/${f.id}/detect-rooms`);
    expect(r.status).toBe(200);
    expect(r.json.note).toBeNull();
    expect(r.json.rooms.map((x: any) => x.name).sort()).toEqual(
      [
        'Covered Patio',
        'Dining',
        'Foyer',
        'Garage',
        'Guest Suite',
        'Kitchen',
        'Living Room',
        'Mudroom',
        'Office',
        'Powder',
        'Stair',
      ].sort(),
    );
    const garage = r.json.rooms.find((x: any) => x.name === 'Garage');
    expect(garage.points).toHaveLength(4);
    // drawn 14' x 12' to the wall centres; the outline follows the inside faces (to a pixel or so)
    expect(garage.areaSqFt).toBeGreaterThan(140);
    expect(garage.areaSqFt).toBeLessThanOrEqual(172);
    // a suggestion only: nothing is saved
    expect((await admin.get(`/api/projects/${projectId}/zones`)).json).toEqual([]);
    // and the outline can be saved as a zone as-is
    const z = await admin.put(`/api/zones/${crypto.randomUUID()}`, {
      projectId,
      floorId: f.id,
      name: garage.name,
      kind: 'room',
      points: garage.points,
    });
    expect(z.status).toBe(200);
    expect(Math.abs(polygonArea(z.json.points))).toBeGreaterThan(0);
  });

  it('explains why there is nothing to find on a sheet uploaded as an image', async () => {
    await admin.upload(`/api/projects/${projectId}/uploads`, path.join(SAMPLES, 'harless-a2.2.png'));
    const floors = (await admin.get(`/api/projects/${projectId}`)).json.floors;
    const img = floors.find((x: any) => x.name.includes('harless-a2.2') || !x.sheetNumber);
    const r = await admin.post(`/api/floors/${img.id}/detect-rooms`);
    expect(r.status).toBe(200);
    expect(r.json.rooms).toEqual([]);
    expect(r.json.note).toMatch(/PDF/);
  });
});
