import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.E2E_ADMIN_PASSWORD ?? '',
};
export const ROOT = process.cwd();
export const SAMPLES = path.join(ROOT, 'docs/samples');
/** resolve deps installed for the server package */
export const serverRequire = createRequire(path.join(ROOT, 'server/package.json'));
export const RUN = process.env.E2E_RUN ?? (process.env.E2E_RUN = Date.now().toString(36));

export async function apiAs(email: string, password: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  const r = await ctx.post('/api/auth/login', { data: { email, password } });
  expect(r.status(), await r.text()).toBe(200);
  return ctx;
}

export async function ensureUser(
  admin: APIRequestContext,
  email: string,
  name: string,
  role: string,
  password: string,
) {
  const r = await admin.post('/api/users', { data: { email, name, role, password } });
  if (r.status() !== 200 && r.status() !== 409) throw new Error(await r.text());
}

export async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

/** Create a project with the two sample sheets via the API, return its id. */
export async function projectWithSheets(
  api: APIRequestContext,
  name: string,
): Promise<{ id: string; floors: any[] }> {
  const p = await (
    await api.post('/api/projects', { data: { name, client: 'E2E', address: '1 Test Way' } })
  ).json();
  for (const f of ['harless-a2.1.png', 'harless-a2.2.png']) {
    const r = await api.post(`/api/projects/${p.id}/uploads`, {
      multipart: { file: { name: f, mimeType: 'image/png', buffer: fs.readFileSync(path.join(SAMPLES, f)) } },
    });
    expect(r.status(), await r.text()).toBe(200);
  }
  const d = await (await api.get(`/api/projects/${p.id}`)).json();
  return { id: p.id, floors: d.floors };
}

/** Click a point on the plan given as fractions of the sheet. */
export async function clickSheet(page: Page, fx: number, fy: number) {
  const img = page.locator('.sheet img');
  await expect(img).toBeVisible();
  const box = (await page.locator('.sheet').boundingBox())!;
  await page
    .locator('.plan')
    .click({ position: await toPlan(page, box.x + box.width * fx, box.y + box.height * fy) });
}

async function toPlan(page: Page, x: number, y: number) {
  const plan = (await page.locator('.plan').boundingBox())!;
  return { x: x - plan.x, y: y - plan.y };
}

export async function sheetPoint(page: Page, fx: number, fy: number) {
  const box = (await page.locator('.sheet').boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

export const markers = (page: Page) => page.locator('.marker');
