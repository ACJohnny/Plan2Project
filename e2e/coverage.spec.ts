import { expect, test, type Page } from '@playwright/test';
import { ADMIN, apiAs, login, projectWithSheets, RUN, sheetPoint } from './helpers';

const center = async (page: Page, sel: string) => {
  const b = (await page.locator(sel).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
};

test('wire paths toggle, and a camera coverage area edited with drag handles', async ({ page }) => {
  const api = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await projectWithSheets(api, `Coverage ${RUN}`);
  const floor = [...proj.floors].sort((a, b) => a.sortOrder - b.sortOrder)[0];
  // 5400 × 3600 px sheet at 0.02 ft/px → 108 × 72 ft
  await api.patch(`/api/floors/${floor.id}`, { data: { ftPerPx: 0.02 } });
  const lib = await (await api.get('/api/device-library')).json();
  const typeId = (code: string) => lib.types.find((t: any) => t.code === code).id;
  await api.put(`/api/zones/${crypto.randomUUID()}`, {
    data: {
      projectId: proj.id,
      floorId: floor.id,
      name: 'Rack',
      kind: 'closet',
      points: [
        [0.05, 0.05],
        [0.15, 0.05],
        [0.15, 0.15],
        [0.05, 0.15],
      ],
    },
  });
  const camId = crypto.randomUUID();
  for (const [id, code, x, y] of [
    [camId, 'CAM', 0.5, 0.5],
    [crypto.randomUUID(), 'TV', 0.7, 0.3],
  ] as const)
    await api.put(`/api/markers/${id}`, {
      data: { projectId: proj.id, floorId: floor.id, typeId: typeId(code), x, y },
    });

  await login(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${proj.id}`);
  await expect(page.locator('.sheet img')).toBeVisible();

  // wire paths: off by default, one path per wired device when ticked
  const wires = page.getByRole('checkbox', { name: 'Wire paths' });
  await expect(page.locator('.wire-path')).toHaveCount(0);
  await wires.check();
  await expect(page.locator('.wire-path')).toHaveCount(2);

  // the camera's coverage shows by default (type default from the admin library)
  await expect(page.locator('.coverage-area')).toHaveCount(1);
  await page.locator('.sched-row', { hasText: 'CAM1' }).click();
  await page.locator('.plan').hover();
  await page.keyboard.press('0'); // fit the sheet so every handle is on screen
  await page.waitForTimeout(400);
  await expect(page.locator('.cov-handle.dir')).toBeVisible();
  await expect(page.locator('.cov-handle.edge')).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath('coverage.png') });

  // rotate: drag the direction handle to the right of the camera → facing 90°
  await drag(page, await center(page, '.cov-handle.dir'), await sheetPoint(page, 0.85, 0.5));
  await expect(page.getByText('Saved')).toBeVisible();
  // widen + shorten: drag the clockwise edge to straight below, 18 ft away → 180°, 18 ft
  await drag(
    page,
    await center(page, '.cov-handle.edge[data-cov="b"]'),
    await sheetPoint(page, 0.5, 0.5 + 18 / 72),
  );
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(page.getByLabel('Range (ft)')).toHaveValue(/^1[78](\.5)?$/);
  await page.screenshot({ path: test.info().outputPath('coverage-edited.png') });
  const get = async () =>
    (await (await api.get(`/api/projects/${proj.id}/markers`)).json()).find((m: any) => m.id === camId);
  await expect
    .poll(async () => (await get()).coverage)
    .toMatchObject({ dirDeg: expect.any(Number), angleDeg: expect.any(Number), rangeFt: expect.any(Number) });
  const c = (await get()).coverage;
  expect(c.dirDeg).toBeGreaterThan(80);
  expect(c.dirDeg).toBeLessThan(100);
  expect(c.angleDeg).toBeGreaterThan(160);
  expect(c.angleDeg).toBeLessThanOrEqual(200);
  expect(c.rangeFt).toBeGreaterThan(16);
  expect(c.rangeFt).toBeLessThan(20);

  // undo restores the previous shape
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await get()).coverage.rangeFt).toBeUndefined();

  // each device can turn its coverage off
  await page.getByRole('checkbox', { name: 'Coverage area' }).uncheck();
  await expect(page.locator('.coverage-area')).toHaveCount(0);
  await expect.poll(async () => (await get()).coverage.on).toBe(false);
});
