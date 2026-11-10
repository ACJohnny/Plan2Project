import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ADMIN, apiAs, login, RUN, SAMPLES, sheetPoint } from './helpers';

test('detect rooms from a PDF drawing, review them, and add the ticked ones as zones', async ({ page }) => {
  const api = await apiAs(ADMIN.email, ADMIN.password);
  const p = await (await api.post('/api/projects', { data: { name: `Rooms ${RUN}` } })).json();
  const up = await (
    await api.post(`/api/projects/${p.id}/uploads`, {
      multipart: {
        file: {
          name: 'harless-plans.pdf',
          mimeType: 'application/pdf',
          buffer: fs.readFileSync(path.join(SAMPLES, 'harless-plans.pdf')),
        },
      },
    })
  ).json();
  await expect
    .poll(async () => (await (await api.get(`/api/uploads/${up.id}`)).json()).status, { timeout: 60_000 })
    .toBe('done');
  // an existing zone over the garage: that room starts unticked
  const floors = (await (await api.get(`/api/projects/${p.id}`)).json()).floors;
  const f = floors.find((x: any) => x.sheetNumber === 'A2.1');
  const found = (await (await api.post(`/api/floors/${f.id}/detect-rooms`)).json()).rooms;
  const garage = found.find((r: any) => r.name === 'Garage');
  await api.put(`/api/zones/${crypto.randomUUID()}`, {
    data: { projectId: p.id, floorId: f.id, name: 'Garage', kind: 'room', points: garage.points },
  });

  await login(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${p.id}`);
  await expect(page.locator('.sheet img')).toBeVisible();
  await page.getByRole('button', { name: 'Edit zones' }).click();
  await page.getByRole('button', { name: 'Detect rooms' }).click();

  const review = page.getByRole('region', { name: 'Rooms found on the drawing' });
  await expect(review.getByText('11 on')).toBeVisible();
  await expect(page.locator('.room-draft')).toHaveCount(11);
  await expect(review.getByRole('checkbox', { name: 'Add Garage' })).not.toBeChecked();
  await expect(review.getByRole('checkbox', { name: 'Add Kitchen' })).toBeChecked();
  await page.screenshot({ path: test.info().outputPath('rooms-found.png') });

  // untick one in the list, one by clicking it on the plan, and rename another
  await review.getByRole('checkbox', { name: 'Add Stair' }).uncheck();
  const office = found.find((r: any) => r.name === 'Office');
  await page.locator('.plan').hover();
  const at = await sheetPoint(page, office.at[0], office.at[1] + 0.03);
  await page.mouse.click(at.x, at.y);
  await expect(review.getByRole('checkbox', { name: 'Add Office' })).not.toBeChecked();
  const patio = review.locator('li', { has: page.getByRole('checkbox', { name: 'Add Covered Patio' }) });
  await patio.getByRole('combobox').fill('Patio');

  await review.getByRole('button', { name: 'Add 8 zones' }).click();
  await expect(page.getByText('Added 8 zones')).toBeVisible();
  await expect(page.locator('.room-draft')).toHaveCount(0);
  // the drawing already prints the names, so the new zones don't (they show dimmed while editing)
  await expect(page.locator('.zone-label.name-hidden', { hasText: 'Patio' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('rooms-added.png') });

  const zones = (await (await api.get(`/api/projects/${p.id}/zones`)).json()) as any[];
  expect(zones.find((z) => z.name === 'Patio').showName).toBe(false);
  expect(zones.map((z) => z.name).sort()).toEqual(
    [
      'Dining',
      'Foyer',
      'Garage',
      'Guest Suite',
      'Kitchen',
      'Living Room',
      'Mudroom',
      'Patio',
      'Powder',
    ].sort(),
  );
});
