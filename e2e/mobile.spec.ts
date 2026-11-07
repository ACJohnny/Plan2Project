import { expect, test } from '@playwright/test';
import { ADMIN, apiAs, login, projectWithSheets, RUN } from './helpers';

/** R-61, R-32, R-33 on an iPhone 13 profile. */
test('phone: pinch-zoom and pan with no sideways scroll, markers keep their size', async ({ page }) => {
  const api = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await projectWithSheets(api, `Phone ${RUN}`);
  const types = (await (await api.get('/api/device-library')).json()).types;
  await api.put(`/api/markers/${crypto.randomUUID()}`, {
    data: { projectId: proj.id, floorId: proj.floors[0].id, typeId: types[0].id, x: 0.5, y: 0.5 },
  });
  await login(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${proj.id}`);
  await expect(page.locator('.sheet img')).toBeVisible();
  const noSideways = async () =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await noSideways()).toBe(true);

  const plan = (await page.locator('.plan').boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(plan.height / vh).toBeGreaterThan(0.6);
  expect(plan.height / vh).toBeLessThan(0.68);

  // tap targets ≥ 40 px
  for (const b of await page.locator('.palette-btn').all()) {
    const bb = (await b.boundingBox())!;
    expect(bb.height).toBeGreaterThanOrEqual(40);
  }

  const marker = page.locator('.marker').first();
  const before = (await marker.boundingBox())!;
  const sheetBefore = (await page.locator('.sheet').boundingBox())!;

  // two-finger pinch via synthetic pointer events (touch)
  const cx = plan.x + plan.width / 2;
  const cy = plan.y + plan.height / 2;
  await page.evaluate(
    async ({ cx, cy }) => {
      const el = document.querySelector('.plan')!;
      const fire = (type: string, id: number, x: number, y: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            clientX: x,
            clientY: y,
            bubbles: true,
            isPrimary: id === 1,
          }),
        );
      fire('pointerdown', 1, cx - 30, cy);
      fire('pointerdown', 2, cx + 30, cy);
      for (let i = 1; i <= 10; i++) {
        fire('pointermove', 1, cx - 30 - i * 10, cy);
        fire('pointermove', 2, cx + 30 + i * 10, cy);
        await new Promise((r) => requestAnimationFrame(r));
      }
      fire('pointerup', 1, cx - 130, cy);
      fire('pointerup', 2, cx + 130, cy);
      // one-finger pan
      fire('pointerdown', 3, cx, cy);
      for (let i = 1; i <= 10; i++) {
        fire('pointermove', 3, cx + i * 8, cy + i * 4);
        await new Promise((r) => requestAnimationFrame(r));
      }
      fire('pointerup', 3, cx + 80, cy + 40);
    },
    { cx, cy },
  );
  const sheetAfter = (await page.locator('.sheet').boundingBox())!;
  expect(sheetAfter.width / sheetBefore.width).toBeGreaterThan(2.5); // zoomed ~3.7×
  const after = (await marker.boundingBox())!;
  expect(Math.abs(after.width - before.width)).toBeLessThan(1); // same screen size
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);
  expect(await noSideways()).toBe(true);
  await expect(page.locator('.zoom-pct')).not.toHaveText('100%');
});
