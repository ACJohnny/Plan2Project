import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDefaultIcons } from '../src/routes/library';
import { login, SAMPLES, setupApp } from './helpers';

let env: Awaited<ReturnType<typeof setupApp>>;
let admin: Awaited<ReturnType<typeof login>>;
let tvId: string;
const file = (name: string, body: string | Buffer) => {
  const p = path.join(env.cfg.DATA_DIR, name);
  fs.writeFileSync(p, body);
  return p;
};
const TINY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';

beforeAll(async () => {
  env = await setupApp();
  admin = await login(env.app, 'admin@example.com', 'admin-password');
  const lib = (await admin.get('/api/device-library')).json;
  tvId = lib.types.find((t: any) => t.code === 'TV').id;
});
afterAll(async () => env?.close());

describe('device icons', () => {
  it('has no icon by default, with the label on', async () => {
    const lib = (await admin.get('/api/device-library')).json;
    const tv = lib.types.find((t: any) => t.id === tvId);
    expect(tv.iconUrl).toBeNull();
    expect(tv.iconLabel).toBe(true);
  });

  it('turns an uploaded SVG into a square transparent PNG, and serves only that', async () => {
    const r = await admin.upload(`/api/device-library/types/${tvId}/icon`, file('a.svg', TINY_SVG));
    expect(r.status).toBe(200);
    expect(r.json.iconUrl).toMatch(/^\/files\/icons\/[a-f0-9]{32}\.png$/);
    const img = await admin.get(r.json.iconUrl);
    expect(img.status).toBe(200);
    const meta = await sharp(img.raw).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 256, height: 256, hasAlpha: true });
    // rendered at full size, not scaled up from 24 px: the circle's edge stays a thin band
    const { data } = await sharp(img.raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let soft = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && data[i] < 255) soft++;
    expect(soft / (256 * 256)).toBeLessThan(0.03);
  });

  it('accepts raster images, and keeps their aspect ratio inside the square', async () => {
    const wide = await sharp({
      create: { width: 400, height: 100, channels: 3, background: '#d00' },
    })
      .jpeg()
      .toBuffer();
    const r = await admin.upload(`/api/device-library/types/${tvId}/icon`, file('b.jpg', wide));
    expect(r.status).toBe(200);
    const img = await admin.get(r.json.iconUrl);
    const { data } = await sharp(img.raw).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0); // top-left corner is padding, not stretched image
  });

  it('rejects anything that is not an image, too-large files and SVG entities', async () => {
    const url = `/api/device-library/types/${tvId}/icon`;
    expect((await admin.upload(url, file('c.png', 'not an image'))).status).toBe(415);
    const evil = `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${TINY_SVG}`;
    expect((await admin.upload(url, file('d.svg', evil))).status).toBe(415);
    const big = await admin.upload(url, file('e.png', Buffer.alloc(3 * 1024 * 1024)));
    expect(big.status).toBe(413);
    expect(big.json.error).toContain('2 MB');
    const missing = `/api/device-library/types/${randomUUID()}/icon`;
    expect((await admin.upload(missing, file('f.svg', TINY_SVG))).status).toBe(404);
  });

  it('only lets admins change icons, and only signed-in users fetch them', async () => {
    const email = `ed${Date.now()}@example.com`;
    await admin.post('/api/users', { email, name: 'Ed', role: 'editor', password: 'editor-password-1' });
    const editor = await login(env.app, email, 'editor-password-1');
    const url = `/api/device-library/types/${tvId}/icon`;
    expect((await editor.upload(url, file('g.svg', TINY_SVG))).status).toBe(403);
    expect((await editor.del(url)).status).toBe(403);
    const lib = (await editor.get('/api/device-library')).json;
    const iconUrl = lib.types.find((t: any) => t.id === tvId).iconUrl;
    expect((await editor.get(iconUrl)).status).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: iconUrl })).statusCode).toBe(401);
    expect((await editor.get('/files/icons/..%2f..%2fetc%2fpasswd')).status).toBe(404);
  });

  it('keeps per-device label choices through other edits, and draws icons in the PDF', async () => {
    const projectId = (await admin.post('/api/projects', { name: 'Icons' })).json.id;
    await admin.upload(`/api/projects/${projectId}/uploads`, path.join(SAMPLES, 'harless-a2.1.png'));
    const floorId = (await admin.get(`/api/projects/${projectId}`)).json.floors[0].id;
    const id = randomUUID();
    const body = { projectId, floorId, typeId: tvId, x: 0.5, y: 0.5 };
    const created = await admin.put(`/api/markers/${id}`, body);
    expect(created.json.iconLabel).toBeNull();
    await admin.put(`/api/markers/${id}`, { ...body, iconLabel: false });
    const edited = await admin.put(`/api/markers/${id}`, { ...body, room: 'Den' });
    expect(edited.json).toMatchObject({ iconLabel: false, room: 'Den' });

    const before = (await admin.get(`/api/projects/${projectId}/export.pdf`)).raw;
    expect(before.length).toBeGreaterThan(0);
    await PDFDocument.load(before);

    // a type's default applies to devices that haven't chosen
    const patched = await admin.patch(`/api/device-library/types/${tvId}`, { iconLabel: false });
    expect(patched.json.iconLabel).toBe(false);

    // removing the icon goes back to the tag, leaving the device's choice in place
    const removed = await admin.del(`/api/device-library/types/${tvId}/icon`);
    expect(removed.json.iconUrl).toBeNull();
    const pdf = await admin.get(`/api/projects/${projectId}/export.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.length).toBeLessThan(before.length);
  });

  it('seeds default icons once, keeping replaced and removed ones', async () => {
    const types = async () => (await admin.get('/api/device-library')).json.types as any[];
    const of = async (code: string) => (await types()).find((t) => t.code === code);
    // an admin replaced CAM's icon before seeding; TV's was removed by the test above
    const camId = (await of('CAM')).id;
    const mine = (await admin.upload(`/api/device-library/types/${camId}/icon`, file('h.svg', TINY_SVG))).json
      .iconUrl;
    const custom = (
      await admin.post('/api/device-library/types', {
        categoryId: (await of('CAM')).categoryId,
        code: 'CUSTOM',
        name: 'Custom',
      })
    ).json;

    const added = await seedDefaultIcons(env.db, env.app.ctx.storage);
    expect(added).toBe((await types()).filter((t) => t.iconUrl).length - 1); // all but CAM's own
    expect((await of('CAM')).iconUrl).toBe(mine);
    expect((await of('TV')).iconUrl).toBeNull();
    expect((await of('CUSTOM')).iconUrl).toBeNull();
    expect(custom.iconUrl).toBeNull();

    // every other seeded type has one, each a distinct picture that renders
    const seeded = (await types()).filter((t) => !['CAM', 'TV', 'CUSTOM'].includes(t.code));
    expect(seeded.every((t) => t.iconUrl)).toBe(true);
    expect(new Set(seeded.map((t) => t.iconUrl)).size).toBe(seeded.length);
    const img = await admin.get((await of('WAP')).iconUrl);
    expect(await sharp(img.raw).metadata()).toMatchObject({ format: 'png', width: 256 });

    // removing one sticks across a restart
    await admin.del(`/api/device-library/types/${(await of('WAP')).id}/icon`);
    expect(await seedDefaultIcons(env.db, env.app.ctx.storage)).toBe(0);
    expect((await of('WAP')).iconUrl).toBeNull();
  });
});
