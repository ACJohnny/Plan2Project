import zlib from 'node:zlib';

/** Convert a WOFF 1.0 font to a plain sfnt (TTF/OTF) buffer; fontkit's WOFF path is unreliable. */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.toString('latin1', 0, 4) !== 'wOFF') return woff;
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables: { tag: number; checksum: number; data: Buffer }[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const tag = woff.readUInt32BE(o);
    const offset = woff.readUInt32BE(o + 4);
    const compLength = woff.readUInt32BE(o + 8);
    const origLength = woff.readUInt32BE(o + 12);
    const checksum = woff.readUInt32BE(o + 16);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? zlib.inflateSync(raw) : Buffer.from(raw);
    tables.push({ tag, checksum, data });
  }
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector++;
  }
  searchRange *= 16;
  const headerLen = 12 + numTables * 16;
  const total = tables.reduce((n, t) => n + ((t.data.length + 3) & ~3), headerLen);
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let offset = headerLen;
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    out.writeUInt32BE(t.tag, o);
    out.writeUInt32BE(t.checksum, o + 4);
    out.writeUInt32BE(offset, o + 8);
    out.writeUInt32BE(t.data.length, o + 12);
    t.data.copy(out, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return out;
}
