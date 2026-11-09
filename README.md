# Six Point Markup

Six Point Technology staff use this self-hosted web app to upload building plans and mark AV and low-voltage device locations on each floor. It supports multiple projects and users, live collaboration, and print PDF / CSV exports.

- **Stack:** TypeScript throughout. Fastify on Node 20, React 18 + Vite, PostgreSQL 16 with Drizzle, sharp, pdf-lib, poppler (`pdftoppm`).
- **Layout:** pnpm workspaces. `server/` (API, PDF conversion and export), `web/` (UI), `shared/` (zod contracts, numbering, coordinates and text exports).
- **Spec:** [Requirments.txt](Requirments.txt). Commits reference requirement IDs (R-1…R-71).

> **Placeholders:** the Six Point logo (`web/public/logo.png`), the Harless sample sheets (`docs/samples/`) and the prototype HTML (`docs/prototype/`) are placeholders. Replace them with the real files using the same names, then rebuild.

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env: set SESSION_SECRET (openssl rand -hex 32), POSTGRES_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD, APP_URL
docker compose up -d --build
```

Open `APP_URL` (default http://localhost:8080) and sign in as `ADMIN_EMAIL`.

On boot the app runs any pending migrations and seeds the 22-type device library. If no users exist, it also creates the first admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. To add the demo project (Harless Residence, about 20 markers, labeled as demo data):

```bash
docker compose exec app node server/dist/seed-demo.js     # or, with Node locally: pnpm seed:demo
```

### HTTPS

Terminate TLS at a reverse proxy (Caddy, Traefik or nginx) and set `APP_URL=https://…`. The app trusts `X-Forwarded-*` headers and marks cookies `Secure` when `APP_URL` starts with `https`. The SSE endpoint `/api/projects/:id/events` must not be buffered. nginx needs `proxy_buffering off;` for it; Caddy works as-is:

```
markup.example.com {
  reverse_proxy localhost:8080
}
```

Over plain HTTP on a LAN address the browser has no Clipboard API, so **Copy device list** opens a dialog with the text selected instead. Over HTTPS it copies directly.

## Configuration

Every setting is an environment variable (see [.env.example](.env.example)).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | built by compose | Postgres connection string |
| `SESSION_SECRET` | none, required | Signs session cookies; the app refuses to start without it |
| `APP_URL` | `http://localhost:8080` | Public URL, used for links, the CSRF origin check and cookie flags |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | none | First admin, used only when no users exist |
| `UPLOAD_MAX_MB` | `100` | Largest plan upload accepted |
| `PDF_RENDER_DPI` | `150` | Resolution for PDF pages converted to PNG |
| `PORT` | `8080` | HTTP port inside the container |
| `HOST_PORT` | `8080` | Host port published by compose |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `markup` / none / `markup` | Database credentials for both containers |
| `LOG_LEVEL` | `info` | pino log level (JSON to stdout) |

Volumes: `appdata` mounted at `/data` holds uploads, rendered sheets and thumbnails. `pgdata` holds Postgres.

## Backup and restore

```bash
scripts/backup.sh                      # → backups/YYYY-MM-DD_HHMMSS/{db.dump,data.tar.gz,SHA256SUMS}
scripts/restore.sh backups/2026-11-07_030000   # asks for confirmation; FORCE=1 skips it
```

`backup.sh` runs `pg_dump` (custom format) in the `db` container and tars `/data` from the `app` container, with no downtime. `restore.sh` works on a fresh stack: `docker compose up -d`, then restore. It stops the app, recreates the database, replaces `/data`, then starts the app again. Copy the `backups/` folder off the host, for example with a nightly cron job that runs `backup.sh` and syncs the folder.

## Roles

| Role | Can |
| --- | --- |
| Admin | Everything an Editor can, plus manage users, edit the device library, delete and restore projects, create API tokens |
| Editor | Create and edit projects, upload sheets, place and edit markers, export |
| Viewer | Open projects, view the schedule, copy the list, export PDF and CSV; no edits |

Roles are enforced on every API route, and the UI hides controls the role can't use.

## Using the editor

- **Place:** pick a type in the palette, then click the plan. The type stays armed until you press Esc, choose Select, or click the type again.
- **Move:** drag a marker. Alt-drag duplicates it. Shift-click or Shift-drag (or the Box tool) selects several.
- **Keys:** Delete removes the selection. Esc deselects, then disarms. Arrows nudge 1 px (Shift: 10 px). `+` / `−` / `0` zoom. Ctrl/⌘+Z and Ctrl/⌘+Shift+Z undo and redo. Ctrl/⌘+C / V copy and paste markers, including onto another floor.
- **Floor tabs:** double-click a tab for floor settings (rename, sheet number, replace sheet, delete). Drag tabs, or press Alt+←/→, to reorder.
- **Project menu (⋯):** upload sheets, renumber, history, copy device list, PDF and CSV exports, duplicate, archive.

Every change saves as you go. The toolbar shows Saved / Saving… / Offline, changes queued / Save failed. Other people's changes arrive live through Server-Sent Events.

## Zones, equipment closets and cable runs

- **Zone Edit mode:** zones can be drawn, selected and reshaped only in Zone Edit mode (palette → **Zones → Edit zones**). Outside it, clicking a zone does nothing. Inside it, devices are dimmed and can't be clicked. Choose a device type, or press Esc with nothing selected, to leave the mode.
- **Draw zones:** in Zone Edit, choose **Draw zone** (or **+ New zone**). Click the corners of a room and finish by clicking the first corner or pressing Enter. Backspace removes the last corner. To draw a rectangle instead, drag. Name the zone and pick **Room** or **Equipment closet**.
- **Edit zones:** in Zone Edit, click a zone to select it, then drag its corner handles to reshape it. The side panel edits the name, kind and audio format; Delete removes it. With nothing selected, the side panel lists the floor's zones.
- **Zones table:** Project menu → **Zones…** (or palette → **All zones**) lists every zone on every floor. You can edit the name, kind and audio format, see device and run counts, jump to a zone, or delete it. Renaming a zone also renames the Room of devices that took the old name.
- **Zone names:** Admin → **Zone names** is the list of names suggested when naming a zone or typing a device's Room. It's seeded with common rooms; admins add, rename, reorder and delete names.
- **Rooms from zones:** devices placed inside a zone get the zone's name as their Room. Moving a device into another zone updates a Room that was blank or came from the old zone.
- **Closets:** every device runs to the **first** equipment closet in floor order. When a project has more than one closet, the device panel has a **Closet** picker to choose another.
- **Wires:** each device type has wires (for example TV = 2× Cat6 + 1× RG6), edited under Admin → Device library. That page also manages the wire types.
- **Scale:** open Floor settings and pick a drawing scale (PDF pages know their DPI), or click **Calibrate scale** and then two points of a known distance.
- **Run length:** a right-angle path in the plan to the closet's center. Runs that change floors go device → **riser** (Zones → Set riser on each floor) → the floor-to-floor heights (Floor settings; floors stack in tab order) → riser → closet. The project's **Extra wire length per run** (Project settings) is added to every run.
- **Audio zones:** a room with audio devices gets an audio format (Stereo, 5.0, 5.1, 7.1).
- **Summary:** Project menu → **Summary** lists audio zones by format and cable totals per wire type. It also lists devices whose runs can't be measured yet, and why. The same summary is the last page of the PDF. The CSV adds `zone`, `closet`, `wires` and `run_ft` columns. `GET /api/projects/:id/summary` returns it as JSON.

## Device icons

Admins can add an icon to any device type (Admin → Device library → Edit: PNG, JPG, WebP or SVG, up to 2 MB). Devices of that type then show the icon instead of the code tag, on the plan and in the PDF. Types without an icon keep the tag.

The code and number (`CAM1`) print below the icon by default. The type sets that default, and each device has a checkbox in its side panel to override it.

Uploads are converted to a 256 px transparent PNG under `/data/icons`; the original file isn't kept.

The seeded device types start with a default icon from [Material Design Icons](https://pictogrammers.com/library/mdi/) ([licence](docs/third-party/material-design-icons-LICENSE.txt)). They're added once per type at startup, so an icon an admin replaces or removes stays that way.

## Wire paths and coverage areas

- **Wire paths:** tick **Wire paths** in the toolbar to draw each device's right-angle run to its equipment closet: device → riser on other floors, and a dark trunk from the riser to the closet. The selected device's path is solid; the rest are dashed. The setting is remembered per browser.
- **Coverage areas:** device types can have a coverage area, such as a camera's field of view or a WAP's range. Set it in Admin → Device library → Edit type → **Coverage area**: on by default or not, range (ft) and angle (°, 360 = full circle). Cameras, WAPs, video doorbells and sensors are seeded; the sensor is off by default.
- **Per device:** the side panel's **Coverage area** checkbox turns it on or off for that device. Range, angle and facing can be typed there. With one device selected, drag the bracket handles at the ends of the arc to change angle and range, and the round ✥ handle to rotate. Edits go into undo history. **Reset to defaults** drops the device's overrides.
- Coverage needs the floor's scale to draw. **Coverage** in the toolbar hides or shows all areas. Coverage areas also print on the PDF floor pages.

## API

The JSON REST API lives under `/api`, with interactive OpenAPI docs at **`/api/docs`** (raw spec at `/api/docs/json`). Scripts can read data with an admin-created read-only token (Admin → API tokens):

```bash
curl -H "Authorization: Bearer spm_…" https://markup.example.com/api/projects
curl -H "Authorization: Bearer spm_…" https://markup.example.com/api/projects/<id>/markers
curl -H "Authorization: Bearer spm_…" -o plan.csv https://markup.example.com/api/projects/<id>/export.csv
```

Marker IDs are UUIDs generated in the browser. `PUT /api/markers/:id` upserts by that ID, and the server assigns numbers inside a per-project lock.

## Development

You need Node 20 and pnpm 9 (`corepack enable`), plus `poppler-utils` for PDF conversion.

```bash
pnpm install
docker run -d --name spm-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres SESSION_SECRET=dev-secret-dev-secret \
       ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=admin-password DATA_DIR=./.data
pnpm dev:server      # API on :8080
pnpm dev:web         # Vite on :5173, proxies /api and /files
```

On a host without Node, `scripts/dev-shell.sh "<command>"` runs any command in a Node 20 + poppler container with the repo mounted.

- **Schema changes:** edit `server/src/db/schema.ts`, then run `pnpm db:generate` and commit the new SQL in `server/drizzle/`.
- **Lint and format:** `pnpm lint` / `pnpm format`.

### Tests

| Suite | Command | Covers |
| --- | --- | --- |
| Unit (Vitest) | `pnpm test` | numbering, renumber ordering, coordinate math, text and CSV exports, sheet-title extraction, PDF layout |
| API integration | `pnpm test` with `TEST_DATABASE_URL` set (a throwaway Postgres; each file creates its own database) | auth, roles, CSRF, lockout, uploads and PDF conversion, numbering under concurrency, undo/restore, renumber, exports, library, tokens |
| End-to-end (Playwright) | `pnpm test:e2e` against a running stack (`E2E_BASE_URL`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`), or `scripts/e2e.sh` in Docker | the v1 acceptance list at 1440 px desktop and on an iPhone 13 profile |

Without Node: `TEST_DB=1 scripts/dev-shell.sh "pnpm test"` and `scripts/e2e.sh`. `scripts/e2e.sh` starts its own throwaway stack (fresh database, no published port) and removes it afterwards, so it leaves the running app's data alone.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit and integration tests, then the e2e suite against `docker compose up`, then builds the image.
