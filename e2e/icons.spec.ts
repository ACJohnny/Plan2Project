import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { ADMIN, apiAs, login, projectWithSheets, RUN } from './helpers';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0a7"/></svg>',
);

test('an icon added in the admin panel replaces the tag, with a per-device label', async ({ page }) => {
  const api = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await projectWithSheets(api, `Icons ${RUN}`);
  const floor = [...proj.floors].sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const lib = await (await api.get('/api/device-library')).json();
  // a throwaway type, so the shared library's devices keep their tags
  const code = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
  const type = await (
    await api.post('/api/device-library/types', {
      data: { categoryId: lib.categories[0].id, code, name: `Icon test ${code}` },
    })
  ).json();

  // retire the throwaway type afterwards, pass or fail, so it stays out of everyone's palette
  try {
    await run();
  } finally {
    await api.patch(`/api/device-library/types/${type.id}`, { data: { retired: true } });
  }

  async function run() {
    await login(page, ADMIN.email, ADMIN.password);
    await page.goto('/admin');
    await page.getByRole('tab', { name: /device library/i }).click();
    await page.getByRole('button', { name: `Edit ${code}` }).click();
    await page
      .getByLabel('Icon file')
      .setInputFiles({ name: 'i.svg', mimeType: 'image/svg+xml', buffer: SVG });
    await expect(page.getByAltText('Icon preview')).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByAltText(`${code} icon`)).toBeVisible();

    const id = crypto.randomUUID();
    await api.put(`/api/markers/${id}`, {
      data: { projectId: proj.id, floorId: floor.id, typeId: type.id, x: 0.5, y: 0.5 },
    });
    await page.goto(`/p/${proj.id}`);
    const pin = page.locator(`[data-marker="${id}"]`);
    await expect(pin.locator('img')).toBeVisible();
    // the image really loaded (signed-in file route)
    await expect.poll(() => pin.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(256);
    await expect(pin.locator('.marker-label')).toHaveText(`${code}1`);
    await page.screenshot({ path: test.info().outputPath('icon.png') });

    // the icon's centre stays on the device's point, and the label hangs below it
    const box = (await pin.boundingBox())!;
    const label = (await pin.locator('.marker-label').boundingBox())!;
    expect(label.y).toBeGreaterThan(box.y + box.height);

    // each device can hide its label; undo brings it back
    await pin.click();
    const check = page.getByRole('checkbox', { name: `Print ${code}1 below the icon` });
    await check.uncheck();
    await expect(pin.locator('.marker-label')).toHaveCount(0);
    const saved = async () =>
      (await (await api.get(`/api/projects/${proj.id}/markers`)).json()).find((m: any) => m.id === id)
        .iconLabel;
    await expect.poll(saved).toBe(false);
    await page.locator('.plan').hover();
    await page.keyboard.press('Control+z');
    await expect(pin.locator('.marker-label')).toBeVisible();

    // the PDF draws the icon too; a second device, with its label hidden, sits beside the first
    await api.put(`/api/markers/${crypto.randomUUID()}`, {
      data: { projectId: proj.id, floorId: floor.id, typeId: type.id, x: 0.6, y: 0.5, iconLabel: false },
    });
    const pdf = await api.get(`/api/projects/${proj.id}/export.pdf`);
    expect(pdf.status()).toBe(200);
    fs.writeFileSync(test.info().outputPath('icons.pdf'), await pdf.body());
  }
});
