import { expect, test, type Page } from '@playwright/test';
import { ADMIN, apiAs, login, projectWithSheets, RUN, sheetPoint } from './helpers';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
};
const fit = async (page: Page) => {
  await page.locator('.plan').hover();
  await page.keyboard.press('0');
  await page.waitForTimeout(400);
};

async function setup(name: string, zones: Record<string, number[][]>) {
  const api = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await projectWithSheets(api, `${name} ${RUN}`);
  const floor = [...proj.floors].sort((a: any, b: any) => a.sortOrder - b.sortOrder)[0];
  const ids: Record<string, string> = {};
  for (const [zone, points] of Object.entries(zones)) {
    ids[zone] = crypto.randomUUID();
    await api.put(`/api/zones/${ids[zone]}`, {
      data: { projectId: proj.id, floorId: floor.id, name: zone, kind: 'room', points },
    });
  }
  const pts = async (zone: string) =>
    (await (await api.get(`/api/projects/${proj.id}/zones`)).json()).find((z: any) => z.id === ids[zone])
      .points;
  return { api, proj, floor, pts };
}
async function open(page: Page, projId: string) {
  await login(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${projId}`);
  await expect(page.locator('.sheet img')).toBeVisible();
  await fit(page);
  await page.getByRole('button', { name: 'Edit zones' }).click();
}

test('a corner snaps to a nearby zone corner, then an edge; Alt skips snapping', async ({ page }) => {
  // the sample sheet's lines stay out of this: only zones are in play
  const { api, proj, pts } = await setup('SnapZones', {
    A: rect(0.2, 0.2, 0.3, 0.3),
    B: rect(0.4, 0.45, 0.5, 0.55),
  });
  await api.patch(`/api/projects/${proj.id}`, { data: { snapToLines: false } });
  await open(page, proj.id);
  await page.mouse.click((await sheetPoint(page, 0.45, 0.5)).x, (await sheetPoint(page, 0.45, 0.5)).y);
  await expect(page.locator('.vertex')).toHaveCount(4);

  // B's first corner to 8 px from A's corner at (0.3, 0.3): lands exactly on it
  const target = await sheetPoint(page, 0.3, 0.3);
  await page.mouse.move((await sheetPoint(page, 0.4, 0.45)).x, (await sheetPoint(page, 0.4, 0.45)).y);
  await page.mouse.down();
  await page.mouse.move(target.x + 6, target.y + 5, { steps: 6 });
  await expect(page.locator('.snap-guide.corner')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('snap-corner.png') });
  await page.mouse.up();
  await expect(page.locator('.snap-guide')).toHaveCount(0);
  await expect.poll(async () => (await pts('B'))[0]).toEqual([0.3, 0.3]);

  // the next corner to just below the middle of A's bottom edge: lands on the edge, not the corner
  const edge = await sheetPoint(page, 0.25, 0.3);
  await drag(page, await sheetPoint(page, 0.5, 0.45), { x: edge.x, y: edge.y + 6 });
  await expect
    .poll(async () => {
      const p = (await pts('B'))[1];
      return Math.abs(p[1] - 0.3) < 0.0001 && Math.abs(p[0] - 0.25) < 0.01;
    })
    .toBe(true);

  // Alt drags freely: next to A's corner, without landing on it
  const corner = await sheetPoint(page, 0.2, 0.3);
  await page.keyboard.down('Alt');
  await drag(page, await sheetPoint(page, 0.5, 0.55), { x: corner.x + 6, y: corner.y + 5 });
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await pts('B'))[2][0]).not.toBe(0.5);
  const free = (await pts('B'))[2];
  expect(free).not.toEqual([0.2, 0.3]);
  expect(Math.abs(free[0] - 0.2)).toBeLessThan(0.02);
});

test('a corner snaps to lines on the drawing, per project', async ({ page }) => {
  const { api, proj, floor, pts } = await setup('SnapLines', { Z: rect(0.45, 0.45, 0.55, 0.55) });
  const lines = await (await api.get(`/api/floors/${floor.id}/sheet-lines`)).json();
  // the longest vertical line that passes through the zone's height
  const [lx] = lines.v
    .filter(
      (l: number[]) =>
        l[1] < 0.5 && l[2] > 0.5 && Math.abs(l[0] - 0.45) > 0.03 && Math.abs(l[0] - 0.55) > 0.03,
    )
    .sort((a: number[], b: number[]) => b[2] - b[1] - (a[2] - a[1]))[0];
  await open(page, proj.id);
  const centre = await sheetPoint(page, 0.5, 0.5);
  await page.mouse.click(centre.x, centre.y);
  await expect(page.locator('.vertex')).toHaveCount(4);

  // one screen pixel as a fraction of the sheet's width, and the lines a corner at height y could use
  const pxFrac = 1 / ((await sheetPoint(page, 1, 0)).x - (await sheetPoint(page, 0, 0)).x);
  const usable = (y: number) =>
    lines.v.filter((l: number[]) => l[1] <= y && l[2] >= y).map((l: number[]) => l[0]);
  const y1 = 0.48;
  const nearest = (x: number) =>
    usable(y1).reduce((b: number, p: number) => (Math.abs(p - x) < Math.abs(b - x) ? p : b), Infinity);

  // 3 px from a line: lands exactly on the nearest line, and stays put along it
  const dropX = lx + 3 * pxFrac;
  const drop = await sheetPoint(page, dropX, y1);
  await drag(page, await sheetPoint(page, 0.45, 0.45), drop);
  await expect.poll(async () => Math.abs((await pts('Z'))[0][0] - nearest(dropX))).toBeLessThan(0.00002);

  // a spot with no line within 8 px stays where it's dropped: a light snap
  let freeX = lx + 8 * pxFrac;
  while (Math.abs(nearest(freeX) - freeX) < 8 * pxFrac) freeX += pxFrac;
  const [x1, y2] = (await pts('Z'))[0];
  await drag(page, await sheetPoint(page, x1, y2), await sheetPoint(page, freeX, y1));
  await expect.poll(async () => Math.abs((await pts('Z'))[0][0] - freeX)).toBeLessThan(pxFrac * 1.5);

  // the project option turns it off: 3 px from the line, it stays 3 px from the line
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'Project settings…' }).click();
  const box = page.getByRole('checkbox', { name: 'Snap zone outlines to lines on the drawing' });
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const [x0, y0] = (await pts('Z'))[0];
  await drag(page, await sheetPoint(page, x0, y0), drop);
  await expect.poll(async () => Math.abs((await pts('Z'))[0][0] - dropX)).toBeLessThan(pxFrac * 1.5);
  expect(Math.abs((await pts('Z'))[0][0] - nearest(dropX))).toBeGreaterThan(0.0001);
});

test('pulling a box corner: nearly straight edges come out exactly straight', async ({ page }) => {
  // no other zones and no drawing lines: nothing else to snap to
  const { api, proj, pts } = await setup('Straight', { Z: rect(0.3, 0.3, 0.6, 0.6) });
  await api.patch(`/api/projects/${proj.id}`, { data: { snapToLines: false } });
  await open(page, proj.id);
  const inside = await sheetPoint(page, 0.45, 0.45);
  await page.mouse.click(inside.x, inside.y);
  await expect(page.locator('.vertex')).toHaveCount(4);
  const px = 1 / ((await sheetPoint(page, 1, 0)).x - (await sheetPoint(page, 0, 0)).x);

  // bottom-right corner, pulled right and 5 px off level with its neighbor: the bottom edge stays level
  const out = await sheetPoint(page, 0.7, 0.6);
  await page.mouse.move((await sheetPoint(page, 0.6, 0.6)).x, (await sheetPoint(page, 0.6, 0.6)).y);
  await page.mouse.down();
  await page.mouse.move(out.x, out.y + 5, { steps: 6 });
  await expect(page.locator('.snap-guide.axis')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('straight.png') });
  await page.mouse.up();
  await expect(page.locator('.snap-guide')).toHaveCount(0);
  await expect.poll(async () => (await pts('Z'))[2][1]).toBe(0.6);
  expect(Math.abs((await pts('Z'))[2][0] - 0.7)).toBeLessThan(px * 1.5);

  // back to 5 px off both neighbors: a square corner again
  const home = await sheetPoint(page, 0.6, 0.6);
  await drag(page, await sheetPoint(page, 0.7, 0.6), { x: home.x + 5, y: home.y - 5 });
  await expect.poll(async () => (await pts('Z'))[2]).toEqual([0.6, 0.6]);

  // pulled well off, it goes where it's put
  await drag(page, home, { x: home.x + 40, y: home.y + 30 });
  await expect.poll(async () => Math.abs((await pts('Z'))[2][0] - (0.6 + 40 * px))).toBeLessThan(px * 1.5);
  expect((await pts('Z'))[2][1]).not.toBe(0.6);

  // Alt skips it
  const [x2, y2] = (await pts('Z'))[2];
  await page.keyboard.down('Alt');
  await drag(page, await sheetPoint(page, x2, y2), { x: home.x + 5, y: home.y + 5 });
  await page.keyboard.up('Alt');
  await expect.poll(async () => Math.abs((await pts('Z'))[2][0] - (0.6 + 5 * px))).toBeLessThan(px * 1.5);
  await page.keyboard.press('Escape');

  // drawing a new outline: the second corner lines up with the first
  await page.getByRole('button', { name: 'Draw zone' }).click();
  const a = await sheetPoint(page, 0.75, 0.2);
  const b = await sheetPoint(page, 0.85, 0.2);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y + 3, { steps: 3 });
  await expect(page.locator('.snap-guide.axis')).toHaveCount(1);
  await page.mouse.click(b.x, b.y + 3);
  await page.mouse.click((await sheetPoint(page, 0.8, 0.3)).x, (await sheetPoint(page, 0.8, 0.3)).y);
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: /^New (zone|equipment closet)$/ });
  await dlg.getByLabel('Name', { exact: true }).fill('Drawn');
  await dlg.getByRole('button', { name: 'Save zone' }).click();
  await expect(dlg).toHaveCount(0);
  await expect
    .poll(async () => {
      const zones = await (await api.get(`/api/projects/${proj.id}/zones`)).json();
      const p = zones.find((z: any) => z.name === 'Drawn')?.points;
      return p ? p[0][1] === p[1][1] : false;
    })
    .toBe(true);
});

test('double-click an outline adds a draggable corner; double-click a corner removes it', async ({
  page,
}) => {
  const { api, proj, pts } = await setup('Nodes', { Z: rect(0.3, 0.3, 0.6, 0.6) });
  await api.patch(`/api/projects/${proj.id}`, { data: { snapToLines: false } });
  await open(page, proj.id);
  const on = await sheetPoint(page, 0.45, 0.3); // the middle of the top edge

  // works without selecting first, and selects the zone
  await page.mouse.dblclick(on.x, on.y);
  await expect(page.locator('.vertex')).toHaveCount(5);
  await expect.poll(async () => (await pts('Z')).length).toBe(5);
  expect((await pts('Z'))[1]).toEqual([0.45, 0.3]);

  // the new corner drags like the others
  const to = await sheetPoint(page, 0.45, 0.2);
  await drag(page, on, to);
  await expect.poll(async () => Math.abs((await pts('Z'))[1][1] - 0.2)).toBeLessThan(0.003);
  await page.waitForTimeout(450); // so the next click isn't read as a second click

  // double-click and hold moves it in one go
  const right = await sheetPoint(page, 0.6, 0.45);
  await page.mouse.click(right.x, right.y);
  await page.mouse.move(right.x, right.y);
  await page.mouse.down();
  await expect(page.locator('.vertex')).toHaveCount(6);
  const out = await sheetPoint(page, 0.7, 0.45);
  await page.mouse.move(out.x, out.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await pts('Z')).length).toBe(6);
  await expect.poll(async () => Math.abs((await pts('Z'))[3][0] - 0.7)).toBeLessThan(0.003);
  await page.waitForTimeout(450);

  // away from any outline, a double-click adds nothing
  const inside = await sheetPoint(page, 0.45, 0.45);
  await page.mouse.dblclick(inside.x, inside.y);
  await expect(page.locator('.vertex')).toHaveCount(6);
  await page.waitForTimeout(450);

  // a double-click on a corner removes it, down to a floor of 3
  for (const n of [5, 4, 3]) {
    const [x, y] = (await pts('Z'))[0];
    const c = await sheetPoint(page, x, y);
    await page.mouse.dblclick(c.x, c.y);
    await expect(page.locator('.vertex')).toHaveCount(n);
    await expect.poll(async () => (await pts('Z')).length).toBe(n);
    await page.waitForTimeout(450);
  }
  const [x, y] = (await pts('Z'))[0];
  const last = await sheetPoint(page, x, y);
  await page.mouse.dblclick(last.x, last.y);
  await expect(page.getByText('A zone needs at least 3 corners')).toBeVisible();
  await expect(page.locator('.vertex')).toHaveCount(3);
});

test('admins set snap strengths, which apply in open editors', async ({ page }) => {
  const { api, proj, pts } = await setup('Strengths', {
    A: rect(0.2, 0.2, 0.3, 0.3),
    B: rect(0.4, 0.45, 0.5, 0.55),
  });
  await api.patch(`/api/projects/${proj.id}`, { data: { snapToLines: false } });
  await login(page, ADMIN.email, ADMIN.password);
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Snapping' }).click();
  await page.getByLabel("Another zone's corner (px)").fill('0');
  await page.getByLabel("Another zone's edge (px)").fill('0');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Snapping saved')).toBeVisible();

  await page.goto(`/p/${proj.id}`);
  await expect(page.locator('.sheet img')).toBeVisible();
  await fit(page);
  await page.getByRole('button', { name: 'Edit zones' }).click();
  const c = await sheetPoint(page, 0.45, 0.5);
  await page.mouse.click(c.x, c.y);
  const target = await sheetPoint(page, 0.3, 0.3);
  await drag(page, await sheetPoint(page, 0.4, 0.45), { x: target.x + 6, y: target.y + 5 });
  await expect.poll(async () => (await pts('B'))[0][0]).not.toBe(0.4);
  expect((await pts('B'))[0]).not.toEqual([0.3, 0.3]); // off: no pull

  // a change reaches the open editor without a reload
  await api.put('/api/device-library/snap', { data: { cornerPx: 40, edgePx: 0, axisDeg: 0, linePx: 0 } });
  await page.waitForTimeout(500);
  const [x, y] = (await pts('B'))[0];
  await drag(page, await sheetPoint(page, x, y), { x: target.x + 25, y: target.y + 25 });
  await expect.poll(async () => (await pts('B'))[0]).toEqual([0.3, 0.3]); // on, and reaching further
  await api.put('/api/device-library/snap', { data: { cornerPx: 16, edgePx: 10, axisDeg: 3, linePx: 5 } });
});
