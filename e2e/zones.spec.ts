import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { ADMIN, apiAs, login, projectWithSheets, RUN, sheetPoint } from './helpers';

test('zones, equipment closet, scale, run length, audio format and summary', async ({ page }) => {
  const api = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await projectWithSheets(api, `Zones ${RUN}`);
  await api.patch(`/api/projects/${proj.id}`, { data: { extraWireFt: 10 } });
  await login(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${proj.id}`);
  await expect(page.locator('.sheet img')).toBeVisible();

  // 1) Zone Edit mode, then an equipment closet: drag a rectangle with the zone tool
  await expect(page.getByRole('button', { name: 'Draw zone' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit zones' }).click();
  await expect(page.locator('.plan.is-zone-edit')).toBeVisible();
  await page.getByRole('button', { name: 'Draw zone' }).click();
  const a = await sheetPoint(page, 0.1, 0.1);
  const b = await sheetPoint(page, 0.2, 0.25);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  let dlg = page.getByRole('dialog', { name: /^New (zone|equipment closet)$/ });
  // names from the admin list are offered as suggestions
  await expect(dlg.locator('datalist option[value="Living Room"]')).toHaveCount(1);
  await dlg.getByLabel('Name', { exact: true }).fill('Garage rack');
  await dlg.getByLabel('Equipment closet').check();
  await dlg.getByRole('button', { name: 'Save zone' }).click();
  await expect(page.locator('.zone-label', { hasText: 'Garage rack' })).toBeVisible();

  // 2) a room outlined by clicking corners (L-shape), closed by clicking the first corner
  await page.getByRole('button', { name: 'Draw zone' }).click();
  for (const [x, y] of [
    [0.4, 0.4],
    [0.7, 0.4],
    [0.7, 0.6],
    [0.55, 0.6],
    [0.55, 0.75],
    [0.4, 0.75],
    [0.4, 0.4],
  ]) {
    const p = await sheetPoint(page, x, y);
    await page.mouse.click(p.x, p.y);
  }
  dlg = page.getByRole('dialog', { name: /^New (zone|equipment closet)$/ });
  await dlg.getByLabel('Name', { exact: true }).fill('Great Room');
  await dlg.getByRole('button', { name: 'Save zone' }).click();
  await expect(page.locator('.zone-label', { hasText: 'Great Room' })).toBeVisible();
  await page.keyboard.press('Escape'); // deselect zone

  // 3) scale: 1/4" = 1'-0" at 150 DPI from floor settings
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'Floor settings…' }).click();
  await page.getByLabel('Drawing scale').selectOption(`1/4" = 1'-0"`);
  await expect(page.getByText('Sheet is about 144 ft × 96 ft.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // 4) place a speaker inside the room: room auto-fills, run length shows
  await page.getByRole('button', { name: 'In-ceiling speaker, code SPK' }).click();
  const s = await sheetPoint(page, 0.45, 0.7);
  await page.mouse.click(s.x, s.y);
  await expect(page.getByLabel('Room')).toHaveValue('Great Room');
  await expect(page.locator('.cabling').first()).toContainText('Garage rack');
  await expect(page.locator('.cabling').first()).toContainText('1× 16/2 speaker');
  // (0.45,0.7) → closet centroid (0.15,0.175): 0.30×144 + 0.525×96 = 93.6 ft + 10 extra ≈ 104 ft
  await expect(page.locator('.run-len')).toHaveText(/≈ 10[34] ft/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // 5) outside Zone Edit, clicking a zone does nothing; inside it, it selects the zone
  const r = await sheetPoint(page, 0.62, 0.45);
  await page.mouse.click(r.x, r.y);
  await expect(page.getByRole('region', { name: 'Zone Great Room' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit zones' }).click();
  await expect(page.getByRole('region', { name: 'Zones on this floor' })).toContainText('Garage rack');
  await page.mouse.click(r.x, r.y);
  await expect(page.getByRole('region', { name: 'Zone Great Room' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('zones-desktop.png') });
  await page.getByLabel('Audio').selectOption('5.1');
  await expect(page.getByText('Saved')).toBeVisible();
  await page.getByRole('button', { name: 'Done editing zones' }).click();
  await expect(page.locator('.plan.is-zone-edit')).toHaveCount(0);

  // 5b) the zones table edits properties; renaming carries the device's Room along
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'Zones…' }).click();
  const tbl = page.getByRole('dialog', { name: 'Zones' });
  await expect(tbl.getByRole('row')).toHaveCount(3);
  const nameBox = tbl.getByLabel('Name of Great Room');
  await nameBox.fill('Family Room');
  await nameBox.press('Enter');
  await expect(page.locator('.zone-label', { hasText: 'Family Room' })).toBeVisible();
  await expect(tbl.getByLabel('Audio format of Family Room')).toHaveValue('5.1');
  await tbl.getByRole('button', { name: 'Close' }).click();
  await page.locator('.sched-row', { hasText: 'SPK' }).first().click();
  await expect(page.getByLabel('Room')).toHaveValue('Family Room');
  await page.keyboard.press('Escape');

  // 6) summary lists the audio zone and cable totals
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: /Summary/ }).click();
  const sum = page.getByRole('dialog', { name: 'Project summary' });
  await expect(sum.locator('.audio-group', { hasText: '5.1' })).toContainText('Family Room');
  await expect(sum.getByRole('row', { name: /16\/2 speaker/ })).toContainText(/10[34] ft/);
  await page.screenshot({ path: test.info().outputPath('summary.png') });

  // persisted on the server
  const zones = await (await api.get(`/api/projects/${proj.id}/zones`)).json();
  expect(zones.map((z: any) => [z.name, z.kind, z.points.length, z.audioFormat]).sort()).toEqual([
    ['Family Room', 'room', 6, '5.1'],
    ['Garage rack', 'closet', 4, null],
  ]);

  // 7) a zone's name can be hidden when the drawing already shows it
  await sum.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'Zones…' }).click();
  await tbl.getByLabel('Show Family Room label on the plan and PDF').uncheck();
  const label = page.locator('.zone-label', { hasText: 'Family Room' });
  await expect(label).toHaveCount(0);
  await expect(page.locator('.zone-label', { hasText: 'Garage rack' })).toBeVisible();
  await tbl.getByRole('button', { name: 'Close' }).click();
  const pdf = await api.get(`/api/projects/${proj.id}/export.pdf`);
  expect(pdf.status()).toBe(200);
  fs.writeFileSync(test.info().outputPath('hidden-name.pdf'), await pdf.body());
  // still findable while editing zones, and the zone keeps working
  await page.getByRole('button', { name: 'Edit zones' }).click();
  await expect(label).toHaveClass(/name-hidden/);
  await page.screenshot({ path: test.info().outputPath('hidden-name.png') });
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'Zones…' }).click();
  await tbl.getByRole('button', { name: 'Show', exact: true }).first().click(); // sorted: Family Room first
  await page.screenshot({ path: test.info().outputPath('hidden-name-panel.png') });
  await page.getByRole('checkbox', { name: 'Show name on the plan and PDF' }).check();
  await expect(label).not.toHaveClass(/name-hidden/);
  await expect
    .poll(async () =>
      (await (await api.get(`/api/projects/${proj.id}/zones`)).json()).every((z: any) => z.showName),
    )
    .toBe(true);
});
