import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  serverRequire,
  ADMIN,
  apiAs,
  clickSheet,
  ensureUser,
  login,
  markers,
  projectWithSheets,
  RUN,
  SAMPLES,
  sheetPoint,
} from './helpers';

const EDITOR = { email: `editor-${RUN}@example.com`, password: 'editor-pass-1', name: 'Erin Editor' };
const VIEWER = { email: `viewer-${RUN}@example.com`, password: 'viewer-pass-1', name: 'Vic Viewer' };

let admin: APIRequestContext;
let editorApi: APIRequestContext;

test.beforeAll(async () => {
  admin = await apiAs(ADMIN.email, ADMIN.password);
});

/** Each test can run alone (Playwright restarts the worker after a failure). */
async function editor() {
  await ensureUser(admin, EDITOR.email, EDITOR.name, 'editor', EDITOR.password);
  await ensureUser(admin, VIEWER.email, VIEWER.name, 'viewer', VIEWER.password);
  return (editorApi = await apiAs(EDITOR.email, EDITOR.password));
}

test('admin signs in, creates an Editor and a Viewer; each sees only their controls', async ({
  page,
  browser,
}) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.getByRole('link', { name: 'Admin' }).click();
  for (const u of [
    { ...EDITOR, role: 'editor' },
    { ...VIEWER, role: 'viewer' },
  ]) {
    await page.getByRole('button', { name: '+ Add user' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Name').fill(u.name);
    await dlg.getByLabel('Email').fill(u.email);
    await dlg.getByLabel('Role').selectOption(u.role);
    await dlg.getByLabel('Temporary password').fill(u.password);
    await dlg.getByRole('button', { name: 'Add user' }).click();
    await expect(page.getByRole('cell', { name: u.email })).toBeVisible();
  }
  editorApi = await apiAs(EDITOR.email, EDITOR.password);
  const proj = await projectWithSheets(editorApi, `Roles ${RUN}`);

  // editor: palette, new project, delete in editor
  const ed = await browser.newPage();
  await login(ed, EDITOR.email, EDITOR.password);
  await expect(ed.getByRole('button', { name: '+ New project' })).toBeVisible();
  await expect(ed.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await ed.goto(`/p/${proj.id}`);
  await expect(ed.getByRole('complementary', { name: 'Device palette' })).toBeVisible();

  // viewer: no palette, no new project, no delete, but exports
  const vi = await browser.newPage();
  await login(vi, VIEWER.email, VIEWER.password);
  await expect(vi.getByRole('button', { name: '+ New project' })).toHaveCount(0);
  await vi.goto(`/p/${proj.id}`);
  await expect(vi.locator('.sheet img')).toBeVisible();
  await expect(vi.getByRole('complementary', { name: 'Device palette' })).toHaveCount(0);
  await vi.getByRole('button', { name: 'Project menu' }).click();
  await expect(vi.getByRole('menuitem', { name: 'Export PDF…' })).toBeVisible();
  await expect(vi.getByRole('menuitem', { name: /Upload sheets|Renumber|Delete project/ })).toHaveCount(0);
});

test('uploading the 2-page PDF yields two floors with the right sizes, named from sheet titles', async ({
  page,
}) => {
  await editor();
  const p = await (await editorApi.post('/api/projects', { data: { name: `Upload ${RUN}` } })).json();
  await login(page, EDITOR.email, EDITOR.password);
  await page.goto(`/p/${p.id}`);
  await expect(page.getByText('Drop plan sheets here')).toBeVisible(); // R-66 empty state
  await page
    .locator('.dropzone-empty input[type=file]')
    .setInputFiles(path.join(SAMPLES, 'harless-plans.pdf'));
  const picker = page.getByRole('dialog', { name: /Pick pages/ });
  await expect(picker).toBeVisible({ timeout: 60_000 });
  await expect(picker.getByText('A2.1 1st Floor Plan')).toBeVisible();
  await picker.getByRole('button', { name: 'Keep selected pages' }).click();
  await expect(page.getByRole('tab', { name: /A2.1 1st Floor Plan/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /A2.2 2nd Floor Plan/ })).toBeVisible();
  const d = await (await editorApi.get(`/api/projects/${p.id}`)).json();
  expect(d.floors.map((f: any) => [f.name, f.widthPx, f.heightPx])).toEqual([
    ['A2.1 1st Floor Plan', 5400, 3600],
    ['A2.2 2nd Floor Plan', 5400, 3600],
  ]);
});

test('numbering, drag, edit, reload, delete + undo, Ctrl+Z on a move, replace sheet', async ({ page }) => {
  await editor();
  const proj = await projectWithSheets(editorApi, `Markup ${RUN}`);
  await login(page, EDITOR.email, EDITOR.password);
  await page.goto(`/p/${proj.id}`);
  await page.getByRole('button', { name: 'In-ceiling speaker, code SPK' }).click();
  await expect(page.getByText(/Placing In-ceiling speaker · next SPK1/)).toBeVisible();
  for (const x of [0.3, 0.4, 0.5]) await clickSheet(page, x, 0.3);
  await page.getByRole('tab', { name: /a2\.2/i }).click();
  for (const x of [0.3, 0.4]) await clickSheet(page, x, 0.3);
  await expect(markers(page)).toHaveText(['SPK4', 'SPK5']);
  await page.getByRole('tab', { name: /a2\.1/i }).click();
  await expect(markers(page)).toHaveText(['SPK1', 'SPK2', 'SPK3']);
  await page.keyboard.press('Escape'); // deselect
  await page.keyboard.press('Escape'); // disarm
  await expect(page.locator('.place-hint')).toHaveCount(0);

  // drag SPK1
  const spk1 = page.locator('.marker', { hasText: /^SPK1$/ });
  const from = (await spk1.boundingBox())!;
  const to = await sheetPoint(page, 0.3, 0.6);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  // edit room + notes
  await page.getByLabel('Room').fill('Kitchen');
  await page.getByLabel('Notes').fill('Pair with SPK2');
  await page.getByLabel('Notes').blur();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.locator('.marker', { hasText: /^SPK1$/ })).toBeVisible();
  const ms = await (await editorApi.get(`/api/projects/${proj.id}/markers`)).json();
  const m1 = ms.find((m: any) => m.number === 1);
  expect(m1.room).toBe('Kitchen');
  expect(m1.notes).toBe('Pair with SPK2');
  expect(m1.y).toBeGreaterThan(0.5);

  // delete then Undo (toast) restores the same marker
  await page.locator('.marker', { hasText: /^SPK2$/ }).click();
  const id2 = ms.find((m: any) => m.number === 2).id;
  await page.keyboard.press('Delete');
  await expect(page.locator('.marker', { hasText: /^SPK2$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.marker', { hasText: /^SPK2$/ })).toBeVisible();
  await expect(page.getByText('Saved')).toBeVisible();
  const after = await (await editorApi.get(`/api/projects/${proj.id}/markers`)).json();
  expect(after.find((m: any) => m.number === 2).id).toBe(id2);

  // Ctrl/⌘+Z works for a move
  const spk3 = page.locator('.marker', { hasText: /^SPK3$/ });
  const b3 = (await spk3.boundingBox())!;
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2);
  await page.mouse.down();
  await page.mouse.move(b3.x + b3.width / 2 + 120, b3.y + b3.height / 2 + 90, { steps: 6 });
  await page.mouse.up();
  const moved = (await spk3.boundingBox())!;
  expect(moved.x).toBeGreaterThan(b3.x + 100);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => Math.round((await spk3.boundingBox())!.x)).toBe(Math.round(b3.x));

  // replace the sheet with a re-rendered (half-size) copy: markers stay put
  await expect(page.getByText('Saved')).toBeVisible();
  const before = await (
    await editorApi.get(`/api/projects/${proj.id}/markers?floorId=${proj.floors[0].id}`)
  ).json();
  const sharp = serverRequire('sharp');
  const half = path.join(test.info().outputDir, 'rerender.png');
  fs.mkdirSync(path.dirname(half), { recursive: true });
  await sharp(path.join(SAMPLES, 'harless-a2.1.png')).resize({ width: 2700 }).png().toFile(half);
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'Floor settings…' }).click();
  await page.locator('.replace-box input[type=file]').setInputFiles(half);
  await expect(page.getByText('Sheet replaced')).toBeVisible();
  const afterRep = await (
    await editorApi.get(`/api/projects/${proj.id}/markers?floorId=${proj.floors[0].id}`)
  ).json();
  const pos = (l: any[]) => l.map((m) => `${m.id}:${m.x}:${m.y}`).sort();
  expect(pos(afterRep)).toEqual(pos(before));
  const fl = (await (await editorApi.get(`/api/projects/${proj.id}`)).json()).floors[0];
  expect(fl.widthPx).toBe(2700);
});

test('two browsers see each other’s placements within 2 s', async ({ browser }) => {
  await editor();
  const proj = await projectWithSheets(editorApi, `Live ${RUN}`);
  const a = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const b = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await login(a, EDITOR.email, EDITOR.password);
  await login(b, ADMIN.email, ADMIN.password);
  await a.goto(`/p/${proj.id}`);
  await b.goto(`/p/${proj.id}`);
  await expect(a.locator('.presence .avatar')).toHaveCount(1); // R-53
  await a.getByRole('button', { name: 'Camera, code CAM' }).click();
  await clickSheet(a, 0.5, 0.5);
  await expect(b.locator('.marker', { hasText: 'CAM1' })).toBeVisible({ timeout: 2000 });
  await b.getByRole('button', { name: 'Wireless AP, code WAP' }).click();
  await clickSheet(b, 0.6, 0.6);
  await expect(a.locator('.marker', { hasText: 'WAP1' })).toBeVisible({ timeout: 2000 });
});

test('PDF has one 11×17 page per floor plus schedule and totals; CSV and device list', async ({
  page,
  context,
}) => {
  await editor();
  const proj = await projectWithSheets(editorApi, `Exports ${RUN}`);
  const types = (await (await editorApi.get('/api/device-library')).json()).types;
  const spk = types.find((t: any) => t.code === 'SPK').id;
  for (const [i, f] of [proj.floors[0], proj.floors[0], proj.floors[1]].entries()) {
    await editorApi.put(`/api/markers/${crypto.randomUUID()}`, {
      data: { projectId: proj.id, floorId: f.id, typeId: spk, x: 0.2 + i * 0.1, y: 0.3, room: `Room ${i}` },
    });
  }
  const pdf = await editorApi.get(`/api/projects/${proj.id}/export.pdf`);
  expect(pdf.headers()['content-disposition']).toMatch(/exports-.*-device-plan-\d{4}-\d{2}-\d{2}\.pdf/);
  const { PDFDocument } = serverRequire('pdf-lib');
  const doc = await PDFDocument.load(await pdf.body());
  const sizes = doc.getPages().map((p: any) => `${p.getWidth()}x${p.getHeight()}`);
  expect(sizes.slice(0, 2)).toEqual(['1224x792', '1224x792']);
  expect(sizes.length).toBeGreaterThanOrEqual(4);

  const csv = await (await editorApi.get(`/api/projects/${proj.id}/export.csv`)).text();
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).trim().split('\r\n');
  expect(lines[0]).toBe(
    'floor,sheet,tag,code,type,category,number,room,mount_height,notes,x,y,zone,closet,wires,run_ft',
  );
  expect(lines).toHaveLength(4);

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page, EDITOR.email, EDITOR.password);
  await page.goto(`/p/${proj.id}`);
  await expect(page.getByText('Project total:')).toContainText('3'); // counts match the app
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'Copy device list' }).click();
  // Over plain HTTP (non-localhost) there is no Clipboard API, so the app shows the text selected in a dialog (R-56).
  const text = (await page.evaluate(() => !!navigator.clipboard))
    ? await page.evaluate(() => navigator.clipboard.readText())
    : await page.getByRole('dialog', { name: 'Copy device list' }).getByLabel('Device list').inputValue();
  expect(text).toContain(`Exports ${RUN}`);
  expect(text).toContain('harless-a2.1 — 2 devices');
  expect(text).toMatch(/SPK1 · In-ceiling speaker · Room 0 · x 0\.200, y 0\.300/);
});
