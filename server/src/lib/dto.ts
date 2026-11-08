import type { Floor, Marker, Upload, User, Zone } from '@sixpoint/shared';
import type * as s from '../db/schema';
import { fileUrl } from './storage';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function userDto(u: typeof s.users.$inferSelect): User {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    theme: u.theme,
    createdAt: u.createdAt.toISOString(),
  };
}

export function floorDto(f: typeof s.floors.$inferSelect): Floor {
  return {
    id: f.id,
    projectId: f.projectId,
    name: f.name,
    sheetNumber: f.sheetNumber,
    sortOrder: f.sortOrder,
    imageUrl: fileUrl(f.imagePath),
    previewUrl: fileUrl(f.previewPath),
    thumbUrl: fileUrl(f.thumbPath),
    widthPx: f.widthPx,
    heightPx: f.heightPx,
    previewWidthPx: f.previewWidthPx,
    renderDpi: f.renderDpi,
    ftPerPx: f.ftPerPx,
    scaleLabel: f.scaleLabel,
    floorHeightFt: f.floorHeightFt,
    riserX: f.riserX,
    riserY: f.riserY,
    updatedAt: f.updatedAt.toISOString(),
  };
}

export function markerDto(m: typeof s.markers.$inferSelect): Marker {
  return {
    id: m.id,
    projectId: m.projectId,
    floorId: m.floorId,
    typeId: m.typeId,
    number: m.number,
    x: m.x,
    y: m.y,
    room: m.room,
    mountHeight: m.mountHeight,
    notes: m.notes,
    closetZoneId: m.closetZoneId,
    createdBy: m.createdBy,
    updatedBy: m.updatedBy,
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function uploadDto(u: typeof s.uploads.$inferSelect): Upload {
  return {
    id: u.id,
    projectId: u.projectId,
    kind: u.kind,
    filename: u.filename,
    pageCount: u.pageCount,
    pagesDone: u.pagesDone,
    status: u.status,
    error: u.error,
    pages: u.pages.map((p) => ({
      page: p.page,
      floorId: p.floorId,
      name: p.name,
      sheetNumber: p.sheetNumber,
      thumbUrl: p.thumbPath ? fileUrl(p.thumbPath) : null,
      widthPx: p.widthPx,
      heightPx: p.heightPx,
    })),
  };
}

export function zoneDto(z: typeof s.zones.$inferSelect): Zone {
  return {
    id: z.id,
    projectId: z.projectId,
    floorId: z.floorId,
    name: z.name,
    kind: z.kind,
    points: z.points,
    audioFormat: z.audioFormat,
    updatedAt: z.updatedAt.toISOString(),
  };
}

export { iso };
