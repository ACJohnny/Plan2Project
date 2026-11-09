import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { HttpError } from './auth';

sharp.cache(false);
sharp.concurrency(2);

export const THUMB_WIDTH = 600;
export const PREVIEW_MAX_WIDTH = 8000;
export const ICON_PX = 256;
export const ICON_MAX_MB = 2;
const ICON_FORMATS = ['png', 'jpeg', 'webp', 'svg'];

export interface SheetFiles {
  imagePath: string;
  previewPath: string;
  thumbPath: string;
  widthPx: number;
  heightPx: number;
  previewWidthPx: number;
}

export type Magic = 'pdf' | 'png' | 'jpeg' | null;

/** Identify a file by its magic bytes (R-68), never by extension. */
export async function sniff(file: string): Promise<Magic> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(8);
    await fh.read(buf, 0, 8, 0);
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    return null;
  } finally {
    await fh.close();
  }
}

export function sniffBuffer(buf: Buffer): Magic {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

export async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex').slice(0, 32);
}

export class Storage {
  constructor(public readonly root: string) {}

  abs(rel: string): string {
    const p = path.resolve(this.root, rel);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('path escapes data dir');
    return p;
  }

  async init() {
    for (const d of ['sheets', 'icons', 'uploads', 'tmp'])
      await fs.mkdir(path.join(this.root, d), { recursive: true });
  }

  /**
   * Store a sheet image under a content-hashed name and derive preview + thumbnail (R-20).
   * The source is copied, never modified or rotated.
   */
  async storeSheet(src: string): Promise<SheetFiles> {
    const meta = await sharp(src, { limitInputPixels: false }).metadata();
    if (!meta.width || !meta.height) throw new Error('Could not read image dimensions');
    const fmt = meta.format === 'jpeg' ? 'jpg' : 'png';
    const hash = await hashFile(src);
    const imagePath = `sheets/${hash}.${fmt}`;
    const previewPath = `sheets/${hash}.preview.webp`;
    const thumbPath = `sheets/${hash}.thumb.webp`;
    const previewWidthPx = Math.min(meta.width, PREVIEW_MAX_WIDTH);

    if (!(await exists(this.abs(imagePath)))) await fs.copyFile(src, this.abs(imagePath));
    if (!(await exists(this.abs(previewPath)))) {
      await sharp(src, { limitInputPixels: false })
        .resize({ width: previewWidthPx, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .webp({ quality: 88, effort: 3 })
        .toFile(this.abs(previewPath) + '.tmp');
      await fs.rename(this.abs(previewPath) + '.tmp', this.abs(previewPath));
    }
    if (!(await exists(this.abs(thumbPath)))) {
      await sharp(src, { limitInputPixels: false })
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .webp({ quality: 80 })
        .toFile(this.abs(thumbPath) + '.tmp');
      await fs.rename(this.abs(thumbPath) + '.tmp', this.abs(thumbPath));
    }
    return { imagePath, previewPath, thumbPath, widthPx: meta.width, heightPx: meta.height, previewWidthPx };
  }

  /**
   * Normalize an uploaded device icon (PNG, JPG, WebP or SVG) to a square transparent PNG under a
   * content-hashed name. Only the PNG is ever served, so an uploaded SVG never reaches a browser.
   */
  async storeIcon(buf: Buffer): Promise<string> {
    const bad = new HttpError(415, 'Icons must be PNG, JPG, WebP or SVG images');
    let meta;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      throw bad;
    }
    if (!meta.format || !ICON_FORMATS.includes(meta.format) || !meta.width || !meta.height) throw bad;
    // SVGs render at their nominal size, so a 24 × 24 icon needs a higher density to stay sharp
    const svg = meta.format === 'svg';
    if (svg && /<!ENTITY/i.test(buf.toString('utf8'))) throw bad;
    const density = svg
      ? Math.min(2400, Math.ceil((72 * ICON_PX * 2) / Math.max(meta.width, meta.height)))
      : undefined;
    let png: Buffer;
    try {
      png = await sharp(buf, density ? { density } : {})
        .resize(ICON_PX, ICON_PX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    } catch {
      throw bad;
    }
    const rel = `icons/${createHash('sha256').update(png).digest('hex').slice(0, 32)}.png`;
    if (!(await exists(this.abs(rel)))) {
      await fs.writeFile(this.abs(rel) + '.tmp', png);
      await fs.rename(this.abs(rel) + '.tmp', this.abs(rel));
    }
    return rel;
  }

  async thumbOnly(src: string, dest: string): Promise<void> {
    await sharp(src, { limitInputPixels: false })
      .resize({ width: 300, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .webp({ quality: 75 })
      .toFile(this.abs(dest));
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function fileUrl(rel: string | null | undefined): string {
  return rel ? `/files/${rel}` : '';
}
