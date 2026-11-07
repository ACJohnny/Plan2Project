import { describe, expect, it } from 'vitest';
import {
  aspectDiff,
  centerOn,
  contrastRatio,
  deviceCsv,
  deviceListText,
  exportFilename,
  extractSheetTitle,
  findDuplicates,
  fitView,
  fractionToScreen,
  nextNumber,
  parseTag,
  planRenumber,
  screenToFraction,
  slugify,
  SEED_LIBRARY,
  toFraction,
  whiteTextContrast,
  zoomAt,
  type ExportType,
} from '../src';

const m = (id: string, typeId: string, number: number, floorId = 'f1', x = 0.5, y = 0.5) => ({
  id,
  typeId,
  number,
  floorId,
  x,
  y,
});

describe('numbering (R-29)', () => {
  it('starts at 1', () => expect(nextNumber([], 'spk')).toBe(1));
  it('counts across floors per type', () => {
    const ms = [m('a', 'spk', 1, 'f1'), m('b', 'spk', 2, 'f1'), m('c', 'spk', 3, 'f2'), m('d', 'tv', 9)];
    expect(nextNumber(ms, 'spk')).toBe(4);
    expect(nextNumber(ms, 'tv')).toBe(10);
  });
  it('does not fill gaps after deletion', () => {
    expect(nextNumber([m('a', 'spk', 1), m('b', 'spk', 2), m('d', 'spk', 4)], 'spk')).toBe(5);
  });
  it('finds duplicate tags excluding self (R-42)', () => {
    const ms = [m('a', 'spk', 3), m('b', 'spk', 3, 'f2'), m('c', 'tv', 3)];
    expect(findDuplicates(ms, 'spk', 3, 'a').map((x) => x.id)).toEqual(['b']);
  });
  it('parses tags', () => {
    expect(parseTag('spk12')).toEqual({ code: 'SPK', number: 12 });
    expect(parseTag('12')).toBeNull();
  });
});

describe('renumber ordering (R-30)', () => {
  it('orders by floor, then top-to-bottom, then left-to-right', () => {
    const ms = [
      m('f2a', 'spk', 1, 'f2', 0.1, 0.1),
      m('f1-bottom', 'spk', 2, 'f1', 0.1, 0.9),
      m('f1-top-right', 'spk', 3, 'f1', 0.9, 0.1),
      m('f1-top-left', 'spk', 7, 'f1', 0.1, 0.103),
    ];
    const plan = planRenumber(ms, ['f1', 'f2'], 'spk');
    const byId = Object.fromEntries(plan.map((c) => [c.id, c.newNumber]));
    expect(byId).toEqual({ 'f1-top-left': 1, 'f1-top-right': 2, 'f1-bottom': 3, f2a: 4 });
  });
  it('handles all types independently and skips other types when filtered', () => {
    const ms = [m('a', 'spk', 5, 'f1', 0.5, 0.5), m('b', 'tv', 8, 'f1', 0.2, 0.2)];
    expect(planRenumber(ms, ['f1'], null).map((c) => c.newNumber)).toEqual([1, 1]);
    expect(planRenumber(ms, ['f1'], 'tv')).toHaveLength(1);
  });
  it('respects floor order, not floor id', () => {
    const ms = [m('a', 'spk', 1, 'zz', 0, 0), m('b', 'spk', 2, 'aa', 0, 0)];
    expect(planRenumber(ms, ['zz', 'aa'], 'spk').find((c) => c.id === 'b')!.newNumber).toBe(2);
  });
});

describe('coordinate math (R-32..R-34)', () => {
  const sheet = { width: 5400, height: 3600 };
  const vp = { width: 1000, height: 800 };
  it('rounds fractions to 5 dp and clamps', () => {
    expect(toFraction(0.123456789)).toBe(0.12346);
    expect(toFraction(-0.2)).toBe(0);
    expect(toFraction(1.4)).toBe(1);
  });
  it('round-trips screen ↔ fraction', () => {
    const v = fitView(sheet, vp);
    const s = fractionToScreen(v, sheet, 0.25, 0.75);
    const f = screenToFraction(v, sheet, s.x, s.y);
    expect(f.x).toBeCloseTo(0.25, 9);
    expect(f.y).toBeCloseTo(0.75, 9);
  });
  it('keeps the point under the cursor fixed while zooming', () => {
    const v = fitView(sheet, vp);
    const before = screenToFraction(v, sheet, 300, 200);
    const z = zoomAt(v, 2, 300, 200, v.scale);
    const after = screenToFraction(z, sheet, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(z.scale).toBeCloseTo(v.scale * 2);
  });
  it('clamps zoom between 50% and 1200% of fit', () => {
    const v = fitView(sheet, vp);
    expect(zoomAt(v, 100, 0, 0, v.scale).scale).toBeCloseTo(v.scale * 12);
    expect(zoomAt(v, 0.01, 0, 0, v.scale).scale).toBeCloseTo(v.scale * 0.5);
  });
  it('centers on a point', () => {
    const v = centerOn(sheet, vp, 0.5, 0.5, 1);
    const s = fractionToScreen(v, sheet, 0.5, 0.5);
    expect(s).toEqual({ x: 500, y: 400 });
  });
  it('fractions survive a re-render at another resolution (R-22)', () => {
    const big = { width: 10800, height: 7200 };
    expect(aspectDiff(sheet, big)).toBe(0);
    expect(aspectDiff(sheet, { width: 5400, height: 3800 })).toBeGreaterThan(0.02);
  });
});

describe('contrast (R-27)', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(whiteTextContrast('#ffff00')).toBeLessThan(4.5);
  });
  it('seed colors are listed', () => {
    expect(SEED_LIBRARY.flatMap((c) => c.types)).toHaveLength(22);
  });
});

describe('text outputs (R-56, R-58, R-59)', () => {
  const types = new Map<string, ExportType>([
    ['spk', { id: 'spk', code: 'SPK', name: 'In-ceiling speaker', category: 'Audio', color: '#1f6fd1', order: 0 }],
  ]);
  const floors = [{ id: 'f1', name: '1st Floor', sheetNumber: 'A2.1' }];
  const markers = [
    { id: 'a', floorId: 'f1', typeId: 'spk', number: 2, x: 0.12345, y: 0.5, room: 'Kitchen', mountHeight: '', notes: 'pair, "L"' },
    { id: 'b', floorId: 'f1', typeId: 'spk', number: 1, x: 0.1, y: 0.2, room: '', mountHeight: '', notes: '' },
  ];
  it('slugs filenames', () => {
    expect(slugify('Harless Residence #2!')).toBe('harless-residence-2');
    expect(exportFilename('Harless Residence', 'pdf', new Date(2026, 10, 7))).toBe(
      'harless-residence-device-plan-2026-11-07.pdf',
    );
  });
  it('builds CSV with BOM and quoting', () => {
    const csv = deviceCsv(floors, types, markers);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('floor,sheet,tag,code,type,category,number,room,mount_height,notes,x,y');
    expect(lines[1].startsWith('1st Floor,A2.1,SPK1,')).toBe(true);
    expect(lines[2]).toContain('"pair, ""L"""');
  });
  it('builds the plain-text device list', () => {
    const txt = deviceListText({ name: 'Harless' }, floors, types, markers, new Date(2026, 10, 7));
    expect(txt).toContain('Harless');
    expect(txt).toContain('1st Floor (A2.1) — 2 devices');
    expect(txt).toContain('SPK1 · In-ceiling speaker · No room · x 0.100, y 0.200');
    expect(txt).toContain('SPK2 · In-ceiling speaker · Kitchen · x 0.123, y 0.500 · pair, "L"');
  });
  it('extracts sheet titles from pdftotext output (R-19)', () => {
    expect(extractSheetTitle('HARLESS RESIDENCE\n\nA2.1 1ST FLOOR PLAN\nScale 1/4"')).toEqual({
      sheetNumber: 'A2.1',
      title: '1st Floor Plan',
    });
    expect(extractSheetTitle('SHEET TITLE\n2nd Floor Plan\nA2.2\n')).toEqual({ sheetNumber: 'A2.2', title: '2nd Floor Plan' });
    expect(extractSheetTitle('nothing useful here')).toBeNull();
    expect(
      extractSheetTitle('BONUS ROOM\n22\'-0" x 16\'-0"\nSHEET TITLE\n2ND FLOOR PLAN\nN\nSHEET\nSCALE: 1/4" = 1\'-0"\nA2.2\n'),
    ).toEqual({ sheetNumber: 'A2.2', title: '2nd Floor Plan' });
    expect(extractSheetTitle('SHEET TITLE\nCOVERED PATIO\n26\'-0"\n1ST FLOOR PLAN\nN\nSHEET\nA2.1')).toEqual({
      sheetNumber: 'A2.1',
      title: '1st Floor Plan',
    });
  });
});
