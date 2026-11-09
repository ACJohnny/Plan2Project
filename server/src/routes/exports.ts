import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AUDIO_FORMAT_LABEL,
  deviceCsv,
  deviceListText,
  exportFilename,
  Id,
  type CsvExtras,
  resolveCoverage,
  type ResolvedCoverage,
} from '@sixpoint/shared';
import { requireUser } from '../lib/auth';
import { buildPdf } from '../services/pdf';
import { loadProjectData } from '../services/summary';

const Summary = z.object({
  extraWireFt: z.number(),
  wires: z.array(
    z.object({
      wireTypeId: Id,
      name: z.string(),
      runs: z.number(),
      totalFt: z.number(),
      unresolved: z.number(),
    }),
  ),
  audioZones: z.array(
    z.object({
      format: z.string().nullable(),
      label: z.string(),
      zones: z.array(z.object({ id: Id, name: z.string(), floor: z.string(), devices: z.number() })),
    }),
  ),
  runs: z.array(
    z.object({
      markerId: Id,
      closetZoneId: Id.nullable(),
      lengthFt: z.number().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

/** Outputs for every role (R-56..R-59) plus the cable / audio-zone summary. */
export const exportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, storage, cfg } = app.ctx;
  const Q = z.object({
    floors: z.string().optional().describe('Comma-separated floor ids to include (default all)'),
  });
  const P = z.object({ id: Id });

  async function load(projectId: string, floorFilter?: string) {
    const d = await loadProjectData(db, projectId);
    if (!floorFilter) return d;
    const want = new Set(floorFilter.split(',').map((s) => s.trim()));
    const fl = d.floors.filter((f) => want.has(f.id));
    const ids = new Set(fl.map((f) => f.id));
    return {
      ...d,
      floors: fl,
      markers: d.markers.filter((m) => ids.has(m.floorId)),
      zones: d.zones.filter((zz) => ids.has(zz.floorId)),
    };
  }

  const disposition = (name: string) => `attachment; filename="${name}"`;

  app.get(
    '/api/projects/:id/export.txt',
    { schema: { tags: ['exports'], params: P, querystring: Q }, preHandler: requireUser },
    async (req, reply) => {
      const d = await load(req.params.id, req.query.floors);
      const txt = deviceListText(d.project, d.floors, d.types, d.markers);
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', disposition(exportFilename(d.project.name, 'txt')));
      return txt;
    },
  );

  app.get(
    '/api/projects/:id/export.csv',
    { schema: { tags: ['exports'], params: P, querystring: Q }, preHandler: requireUser },
    async (req, reply) => {
      const d = await load(req.params.id, req.query.floors);
      const zoneName = new Map(d.zones.map((zz) => [zz.id, zz.name]));
      const wireName = new Map(d.lib.wireTypes.map((w) => [w.id, w.name]));
      const typeWires = new Map(d.lib.types.map((t) => [t.id, t.wires]));
      const extras = new Map<string, CsvExtras>();
      for (const m of d.markers) {
        const r = d.summary.runs.get(m.id);
        const zid = d.summary.zoneOf.get(m.id);
        extras.set(m.id, {
          zone: zid ? (zoneName.get(zid) ?? '') : '',
          closet: r?.closetId ? (zoneName.get(r.closetId) ?? '') : '',
          wires: (typeWires.get(m.typeId) ?? [])
            .map((w) => `${w.count}× ${wireName.get(w.wireTypeId) ?? '?'}`)
            .join('; '),
          runFt: r?.lengthFt ?? null,
        });
      }
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', disposition(exportFilename(d.project.name, 'csv')));
      return deviceCsv(d.floors, d.types, d.markers, extras);
    },
  );

  app.get(
    '/api/projects/:id/export.pdf',
    { schema: { tags: ['exports'], params: P, querystring: Q }, preHandler: requireUser },
    async (req, reply) => {
      const d = await load(req.params.id, req.query.floors);
      const logo = path.join(cfg.STATIC_DIR, 'logo.png');
      const bytes = await buildPdf(storage, {
        project: d.project,
        floors: d.floors,
        types: d.types,
        markers: d.markers,
        zones: d.zones,
        coverage: coverageMap(d),
        typeIcons: new Map(d.lib.types.flatMap((t) => (t.iconUrl ? [[t.id, iconPathOf(t.iconUrl)]] : []))),
        hiddenLabels: hiddenLabels(d),
        summary: d.summary,
        extraWireFt: d.project.extraWireFt,
        markerScale: d.project.markerScale,
        logoPath: fs.existsSync(logo) ? logo : null,
      });
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', disposition(exportFilename(d.project.name, 'pdf')));
      return reply.send(Buffer.from(bytes));
    },
  );

  app.get(
    '/api/projects/:id/summary',
    {
      schema: {
        tags: ['exports'],
        params: P,
        description:
          'Cable totals per wire type, audio zones by format, and the run length for every device.',
        response: { 200: Summary },
      },
      preHandler: requireUser,
    },
    async (req) => {
      const d = await load(req.params.id);
      const floorName = new Map(d.floors.map((f) => [f.id, f.name]));
      return {
        extraWireFt: d.project.extraWireFt,
        wires: d.summary.wires,
        audioZones: d.summary.audioZones.map((g) => ({
          format: g.format,
          label: g.format ? AUDIO_FORMAT_LABEL[g.format] : 'Not set',
          zones: g.zones.map((zz) => ({
            id: zz.id,
            name: zz.name,
            floor: floorName.get(zz.floorId) ?? '',
            devices: zz.devices,
          })),
        })),
        runs: [...d.summary.runs].map(([markerId, r]) => ({
          markerId,
          closetZoneId: r.closetId,
          lengthFt: r.lengthFt,
          reason: r.reason,
        })),
      };
    },
  );
};

/** Stored path of an icon from its URL (/files/icons/x.png → icons/x.png). */
const iconPathOf = (url: string): string => url.replace(/^\/files\//, '');

/** Devices with an icon whose code + number should not print below it. */
function hiddenLabels(d: Awaited<ReturnType<typeof loadProjectData>>): Set<string> {
  const types = new Map(d.lib.types.map((t) => [t.id, t]));
  return new Set(
    d.markers.filter((m) => !(m.iconLabel ?? types.get(m.typeId)?.iconLabel ?? true)).map((m) => m.id),
  );
}

/** Effective coverage for every device whose coverage is on. */
function coverageMap(d: Awaited<ReturnType<typeof loadProjectData>>): Map<string, ResolvedCoverage> {
  const types = new Map(d.lib.types.map((t) => [t.id, t]));
  const out = new Map<string, ResolvedCoverage>();
  for (const m of d.markers) {
    const c = resolveCoverage(types.get(m.typeId), m);
    if (c) out.set(m.id, c);
  }
  return out;
}
