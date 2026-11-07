// Generates PLACEHOLDER sample assets (replace with the real Harless set and Six Point logo):
//   docs/samples/harless-plans.pdf      2-page 36×24 in plan set with a text layer (A2.1 / A2.2)
//   docs/samples/harless-a2.1.png, harless-a2.2.png  (rendered separately with pdftoppm)
//   web/public/logo.png                 placeholder six-point mark in the logo spectrum
// Run inside the dev container:  node scripts/generate-samples.mjs  (from /repo/server so deps resolve)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(root, 'server/package.json'));
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const sharp = require('sharp');

const IN = 72;
const W = 36 * IN;
const H = 24 * IN;
const ink = rgb(0.12, 0.12, 0.14);
const light = rgb(0.6, 0.6, 0.65);

const floors = [
  {
    num: 'A2.1',
    title: '1ST FLOOR PLAN',
    rooms: [
      ['GARAGE', 2, 2, 7, 6],
      ['MUDROOM', 9, 2, 3, 3],
      ['KITCHEN', 12, 2, 7, 6],
      ['DINING', 19, 2, 6, 6],
      ['LIVING ROOM', 12, 8, 13, 8],
      ['OFFICE', 2, 8, 5, 5],
      ['POWDER', 7, 8, 2, 3],
      ['FOYER', 9, 5, 3, 6],
      ['STAIR', 7, 11, 5, 3],
      ['GUEST SUITE', 2, 13, 10, 7],
      ['COVERED PATIO', 12, 16, 13, 4],
    ],
  },
  {
    num: 'A2.2',
    title: '2ND FLOOR PLAN',
    rooms: [
      ['PRIMARY BEDROOM', 2, 2, 10, 8],
      ['PRIMARY BATH', 12, 2, 6, 5],
      ['CLOSET', 12, 7, 6, 3],
      ['STAIR', 7, 11, 5, 3],
      ['HALL', 12, 10, 13, 2],
      ['BEDROOM 2', 18, 2, 7, 8],
      ['BEDROOM 3', 2, 14, 8, 6],
      ['BATH 2', 10, 14, 4, 6],
      ['BONUS ROOM', 14, 12, 11, 8],
      ['LAUNDRY', 2, 10, 5, 4],
    ],
  },
];

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
doc.setTitle('Harless Residence — sample plan set (placeholder)');

for (const f of floors) {
  const p = doc.addPage([W, H]);
  // border
  p.drawRectangle({ x: 0.5 * IN, y: 0.5 * IN, width: W - IN, height: H - IN, borderColor: ink, borderWidth: 3 });
  // grid
  for (let gx = 2; gx <= 27; gx += 5) {
    p.drawLine({ start: { x: gx * IN, y: 1 * IN }, end: { x: gx * IN, y: H - 1 * IN }, thickness: 0.6, color: light, dashArray: [18, 10] });
  }
  for (let gy = 2; gy <= 22; gy += 5) {
    p.drawLine({ start: { x: 1 * IN, y: gy * IN }, end: { x: 28 * IN, y: gy * IN }, thickness: 0.6, color: light, dashArray: [18, 10] });
  }
  // rooms (plan coordinates in feet-ish units from top-left; 1 unit = 1 in on paper)
  const ox = 1.5 * IN;
  const oy = H - 1.5 * IN;
  for (const [name, x, y, w, h] of f.rooms) {
    const rx = ox + x * IN;
    const ry = oy - (y + h) * IN;
    p.drawRectangle({ x: rx, y: ry, width: w * IN, height: h * IN, borderColor: ink, borderWidth: 7 });
    const size = 20;
    const tw = bold.widthOfTextAtSize(name, size);
    p.drawText(name, { x: rx + (w * IN - tw) / 2, y: ry + (h * IN) / 2, size, font: bold, color: ink });
    const dims = `${w * 2}'-0" x ${h * 2}'-0"`;
    const dw = font.widthOfTextAtSize(dims, 13);
    p.drawText(dims, { x: rx + (w * IN - dw) / 2, y: ry + (h * IN) / 2 - 22, size: 13, font, color: ink });
  }
  // doors (arcs approximated as short gaps + swing lines)
  for (const [, x, y, w] of f.rooms) {
    const dx = ox + (x + w / 2) * IN;
    const dy = oy - y * IN;
    p.drawLine({ start: { x: dx - 18, y: dy }, end: { x: dx + 18, y: dy }, thickness: 9, color: rgb(1, 1, 1) });
    p.drawLine({ start: { x: dx - 18, y: dy }, end: { x: dx - 18, y: dy - 36 }, thickness: 1.5, color: ink });
  }
  // north arrow + scale
  p.drawText('N', { x: 27 * IN, y: 3.2 * IN, size: 36, font: bold, color: ink });
  p.drawLine({ start: { x: 27.25 * IN, y: 2 * IN }, end: { x: 27.25 * IN, y: 3 * IN }, thickness: 4, color: ink });
  p.drawText('SCALE: 1/4" = 1\'-0"', { x: 2 * IN, y: 1 * IN, size: 18, font, color: ink });

  // title block on the right
  const tbx = 29.5 * IN;
  p.drawLine({ start: { x: tbx, y: 0.5 * IN }, end: { x: tbx, y: H - 0.5 * IN }, thickness: 3, color: ink });
  const tb = (s, y, size, fnt = font) => p.drawText(s, { x: tbx + 0.4 * IN, y: y * IN, size, font: fnt, color: ink });
  tb('PLACEHOLDER SAMPLE — NOT FOR CONSTRUCTION', 22.6, 13, bold);
  tb('HARLESS RESIDENCE', 21, 34, bold);
  tb('1420 Hollow Creek Road', 20.3, 18);
  tb('Six Point Technology — AV / low voltage', 19.6, 15);
  for (let i = 0; i < 6; i++) p.drawLine({ start: { x: tbx, y: (17 - i * 1.4) * IN }, end: { x: W - 0.5 * IN, y: (17 - i * 1.4) * IN }, thickness: 0.8, color: light });
  tb('REV  DATE        DESCRIPTION', 16.4, 12, bold);
  tb('0    2026-10-01  ISSUED FOR PERMIT', 15.0, 12);
  p.drawLine({ start: { x: tbx, y: 5.2 * IN }, end: { x: W - 0.5 * IN, y: 5.2 * IN }, thickness: 3, color: ink });
  tb('SHEET TITLE', 4.6, 12, bold);
  tb(f.title, 3.8, 30, bold);
  tb('SHEET', 2.7, 12, bold);
  tb(f.num, 1.0, 72, bold);
}

const out = path.join(root, 'docs/samples');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'harless-plans.pdf'), await doc.save());
console.log('wrote docs/samples/harless-plans.pdf');

// Placeholder logo: six dots on a hexagon in the spectrum colors (no text; swap for the real logo).
const SPECTRUM = ['#d80060', '#f07800', '#a8c018', '#009078', '#00a8d8', '#781878'];
const dots = SPECTRUM.map((c, i) => {
  const a = (Math.PI / 3) * i - Math.PI / 2;
  return `<circle cx="${120 + Math.cos(a) * 72}" cy="${120 + Math.sin(a) * 72}" r="34" fill="${c}"/>`;
}).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">${dots}<circle cx="120" cy="120" r="30" fill="#5b1762"/></svg>`;
fs.mkdirSync(path.join(root, 'web/public'), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(path.join(root, 'web/public/logo.png'));
await sharp(Buffer.from(svg)).resize(64, 64).png().toFile(path.join(root, 'web/public/favicon.png'));
console.log('wrote web/public/logo.png (placeholder)');
