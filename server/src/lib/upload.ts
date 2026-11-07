import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './auth';
import { sniff, type Magic, type Storage } from './storage';

export interface Received {
  id: string;
  rel: string;
  abs: string;
  filename: string;
  magic: Exclude<Magic, null>;
}

/** Stream one multipart file to /data/uploads/<id>/ and check it by magic bytes (R-17, R-68). */
export async function receiveFile(req: FastifyRequest, storage: Storage, maxMb: number): Promise<Received> {
  const data = await req.file();
  if (!data) throw new HttpError(400, 'No file in the request');
  const id = randomUUID();
  const dirRel = `uploads/${id}`;
  await fs.mkdir(storage.abs(dirRel), { recursive: true });
  const tmpAbs = storage.abs(`${dirRel}/incoming`);
  try {
    await pipeline(data.file, createWriteStream(tmpAbs));
  } catch (e) {
    await fs.rm(storage.abs(dirRel), { recursive: true, force: true });
    throw e;
  }
  if (data.file.truncated) {
    await fs.rm(storage.abs(dirRel), { recursive: true, force: true });
    throw new HttpError(413, `File is larger than ${maxMb} MB`);
  }
  const magic = await sniff(tmpAbs);
  if (!magic) {
    await fs.rm(storage.abs(dirRel), { recursive: true, force: true });
    throw new HttpError(415, 'Only PDF, PNG and JPG files are accepted');
  }
  const ext = magic === 'jpeg' ? 'jpg' : magic;
  const rel = `${dirRel}/original.${ext}`;
  await fs.rename(tmpAbs, storage.abs(rel));
  const filename = path.basename(data.filename || `upload.${ext}`).slice(0, 200);
  return { id, rel, abs: storage.abs(rel), filename, magic };
}

/** "A2.1 1st Floor Plan.png" → "A2.1 1st Floor Plan" */
export function nameFromFilename(f: string): string {
  return (
    f
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[_]+/g, ' ')
      .trim()
      .slice(0, 120) || 'Floor'
  );
}
