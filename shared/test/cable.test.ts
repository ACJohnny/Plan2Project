import { describe, expect, it } from 'vitest';
import {
  centroid,
  computeRun,
  elevations,
  ftPerPxFromCalibration,
  ftPerPxFromScale,
  orderedClosets,
  parseFeet,
  pointInPolygon,
  rectPolygon,
  bearingOf,
  resolveCoverage,
  runPath,
  sectorPath,
  zoneAt,
  type RunFloor,
  type RunZone,
} from '../src';

// 100 ft × 50 ft sheets at 1 px = 0.1 ft → 1000 × 500 px
const f1: RunFloor = {
  id: 'f1',
  name: '1st',
  widthPx: 1000,
  heightPx: 500,
  ftPerPx: 0.1,
  floorHeightFt: 10,
  riser: { x: 0.5, y: 0.5 },
};
const f2: RunFloor = {
  id: 'f2',
  name: '2nd',
  widthPx: 1000,
  heightPx: 500,
  ftPerPx: 0.1,
  floorHeightFt: 9,
  riser: { x: 0.1, y: 0.1 },
};
const closet: RunZone = {
  id: 'eq1',
  floorId: 'f1',
  name: 'EQ',
  kind: 'closet',
  points: rectPolygon(0, 0, 0.2, 0.2),
}; // centroid 0.1,0.1
const closet2: RunZone = {
  id: 'eq2',
  floorId: 'f2',
  name: 'EQ2',
  kind: 'closet',
  points: rectPolygon(0.8, 0.8, 1, 1),
};

describe('geometry', () => {
  it('point in polygon handles L shapes', () => {
    const L: [number, number][] = [
      [0, 0],
      [0.5, 0],
      [0.5, 0.2],
      [0.2, 0.2],
      [0.2, 0.5],
      [0, 0.5],
    ];
    expect(pointInPolygon(0.1, 0.4, L)).toBe(true);
    expect(pointInPolygon(0.4, 0.4, L)).toBe(false);
  });
  it('centroid of a rectangle', () => {
    const [x, y] = centroid(rectPolygon(0.2, 0.2, 0.4, 0.6));
    expect(x).toBeCloseTo(0.3);
    expect(y).toBeCloseTo(0.4);
  });
  it('picks the smallest containing zone', () => {
    const big = {
      id: 'big',
      floorId: 'f1',
      name: 'House',
      kind: 'room' as const,
      points: rectPolygon(0, 0, 1, 1),
    };
    const small = {
      id: 'small',
      floorId: 'f1',
      name: 'Closet',
      kind: 'room' as const,
      points: rectPolygon(0.4, 0.4, 0.6, 0.6),
    };
    expect(zoneAt([big, small], 'f1', 0.5, 0.5)?.id).toBe('small');
    expect(zoneAt([big, small], 'f1', 0.1, 0.1)?.id).toBe('big');
    expect(zoneAt([big, small], 'f2', 0.5, 0.5)).toBeNull();
  });
});

describe('scale', () => {
  it('derives feet per pixel from a drawing scale and DPI', () => {
    // 1/4" = 1'-0" → 4 ft per paper inch; at 150 DPI → 4/150 ft per px
    expect(ftPerPxFromScale(4, 150)).toBeCloseTo(0.026667, 5);
  });
  it('derives feet per pixel from a two-point calibration', () => {
    expect(
      ftPerPxFromCalibration({ x: 0, y: 0 }, { x: 0.3, y: 0.4 }, 50, { width: 1000, height: 1000 }),
    ).toBeCloseTo(0.1);
  });
  it('parses feet and inches', () => {
    expect(parseFeet(`12' 6"`)).toBe(12.5);
    expect(parseFeet(`12'6`)).toBe(12.5);
    expect(parseFeet('12.25')).toBe(12.25);
    expect(parseFeet('18 in')).toBe(1.5);
    expect(parseFeet('abc')).toBeNull();
  });
});

describe('cable runs', () => {
  const floors = [f1, f2];
  it('stacks floor elevations in order', () => {
    expect(Object.fromEntries(elevations(floors))).toEqual({ f1: 0, f2: 10 });
  });
  it('the first closet in floor order is the default', () => {
    expect(orderedClosets(floors, [closet2, closet]).map((c) => c.id)).toEqual(['eq1', 'eq2']);
  });
  it('same floor: right-angle distance plus extra', () => {
    // device at (0.6, 0.3): dx = 0.5*1000 px = 50 ft, dy = 0.2*500 = 10 ft
    const r = computeRun(
      { id: 'm', floorId: 'f1', x: 0.6, y: 0.3, closetZoneId: null },
      floors,
      [closet],
      15,
    );
    expect(r.closetId).toBe('eq1');
    expect(r.baseFt).toBeCloseTo(60);
    expect(r.lengthFt).toBeCloseTo(75);
  });
  it('cross floor: device → riser, floor-to-floor height, riser → closet', () => {
    // on f2 device (0.6,0.6) → riser (0.1,0.1): 50 + 25 = 75 ft; vertical 10; f1 riser (0.5,0.5) → closet (0.1,0.1): 40 + 20 = 60
    const r = computeRun({ id: 'm', floorId: 'f2', x: 0.6, y: 0.6, closetZoneId: null }, floors, [closet], 0);
    expect(r.baseFt).toBeCloseTo(145);
  });
  it('honors a closet override', () => {
    const r = computeRun(
      { id: 'm', floorId: 'f2', x: 0.9, y: 0.9, closetZoneId: 'eq2' },
      floors,
      [closet, closet2],
      0,
    );
    expect(r.closetId).toBe('eq2');
    expect(r.baseFt).toBeCloseTo(0, 6);
  });
  it('explains missing data', () => {
    expect(computeRun({ id: 'm', floorId: 'f1', x: 0, y: 0, closetZoneId: null }, floors, [], 0).reason).toBe(
      'No equipment closet',
    );
    expect(
      computeRun(
        { id: 'm', floorId: 'f2', x: 0, y: 0, closetZoneId: null },
        [f1, { ...f2, riser: null }],
        [closet],
        0,
      ).reason,
    ).toBe('Set a riser on 2nd');
    expect(
      computeRun(
        { id: 'm', floorId: 'f1', x: 0, y: 0, closetZoneId: null },
        [{ ...f1, ftPerPx: null }],
        [closet],
        0,
      ).reason,
    ).toBe('Set the scale on 1st');
  });
});

describe('wire paths', () => {
  it('same floor: one right-angle leg to the closet centroid', () => {
    const legs = runPath({ id: 'm', floorId: 'f1', x: 0.6, y: 0.3, closetZoneId: null }, [f1, f2], [closet]);
    expect(legs).toEqual([
      {
        floorId: 'f1',
        points: [
          [0.6, 0.3],
          [expect.closeTo(0.1), 0.3],
          [expect.closeTo(0.1), expect.closeTo(0.1)],
        ],
      },
    ]);
  });
  it('other floor: device → riser, then riser → closet', () => {
    const legs = runPath({ id: 'm', floorId: 'f2', x: 0.6, y: 0.6, closetZoneId: null }, [f1, f2], [closet]);
    expect(legs.map((l) => l.floorId)).toEqual(['f2', 'f1']);
    expect(legs[0].points.at(-1)).toEqual([0.1, 0.1]); // f2 riser
    expect(legs[1].points[0]).toEqual([0.5, 0.5]); // f1 riser
  });
  it('no route without a closet or riser', () => {
    expect(runPath({ id: 'm', floorId: 'f1', x: 0, y: 0, closetZoneId: null }, [f1], [])).toEqual([]);
    expect(
      runPath(
        { id: 'm', floorId: 'f2', x: 0, y: 0, closetZoneId: null },
        [f1, { ...f2, riser: null }],
        [closet],
      ),
    ).toEqual([]);
  });
});

describe('coverage', () => {
  const cam = { coverage: { defaultOn: true, rangeFt: 40, angleDeg: 90 } };
  it('merges type defaults with device overrides, and can be turned off', () => {
    expect(resolveCoverage(cam, { coverage: null })).toEqual({ rangeFt: 40, angleDeg: 90, dirDeg: 0 });
    expect(resolveCoverage(cam, { coverage: { rangeFt: 25, dirDeg: 135 } })).toEqual({
      rangeFt: 25,
      angleDeg: 90,
      dirDeg: 135,
    });
    expect(resolveCoverage(cam, { coverage: { on: false } })).toBeNull();
    expect(
      resolveCoverage({ coverage: { ...cam.coverage, defaultOn: false } }, { coverage: null }),
    ).toBeNull();
    expect(resolveCoverage({ coverage: null }, { coverage: { on: true } })).toBeNull();
  });
  it('bearings are clockwise from up', () => {
    expect(bearingOf(0, -1)).toBeCloseTo(0);
    expect(bearingOf(1, 0)).toBeCloseTo(90);
    expect(bearingOf(0, 1)).toBeCloseTo(180);
    expect(bearingOf(-1, 0)).toBeCloseTo(270);
  });
  it('draws a sector, or a circle at 360°', () => {
    // 90° facing up from (100,100), r 10: edges at 315° and 45°
    const d = sectorPath(100, 100, 10, 90, 0);
    expect(d).toMatch(/^M 100 100 L 92\.9\d* 92\.9\d* A 10 10 0 0 1 107\.0\d* 92\.9\d* Z$/);
    expect(sectorPath(0, 0, 5, 360, 0)).toContain('a 5 5 0 1 0 10 0');
  });
});
