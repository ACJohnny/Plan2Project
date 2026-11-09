import { z } from 'zod';

/** API contracts shared by server (validation + OpenAPI) and web (typed client). */

export const Role = z.enum(['admin', 'editor', 'viewer']);
export type Role = z.infer<typeof Role>;
export const Theme = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof Theme>;

export const Id = z.string().uuid();
const ts = z.string(); // ISO timestamp

export const User = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  role: Role,
  active: z.boolean(),
  theme: Theme,
  createdAt: ts,
});
export type User = z.infer<typeof User>;

export const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
export const MeResponse = z.object({ user: User, csrf: z.string().optional() });
export const UpdateMeBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    theme: Theme.optional(),
    currentPassword: z.string().optional(),
    newPassword: z.string().min(8).max(200).optional(),
  })
  .refine((b) => !b.newPassword || b.currentPassword, {
    message: 'currentPassword required to change password',
  });

export const CreateUserBody = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  role: Role,
  password: z.string().min(8).max(200),
});
export const UpdateUserBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: Role.optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});

export const Project = z.object({
  id: Id,
  name: z.string(),
  client: z.string(),
  address: z.string(),
  jobNumber: z.string(),
  notes: z.string(),
  archivedAt: ts.nullable(),
  deletedAt: ts.nullable(),
  createdBy: Id.nullable(),
  updatedAt: ts,
  updatedByName: z.string().nullable(),
  floorCount: z.number(),
  deviceCount: z.number(),
  thumbUrl: z.string().nullable(),
  /** extra wire added to every cable run, feet */
  extraWireFt: z.number(),
  /** size of device markers on the plan and PDF; 1 = normal */
  markerScale: z.number(),
  /** zone corners snap to lines detected on the drawing */
  snapToLines: z.boolean(),
});
export type Project = z.infer<typeof Project>;

export const ProjectFields = z.object({
  name: z.string().trim().min(1).max(200),
  client: z.string().max(200).default(''),
  address: z.string().max(400).default(''),
  jobNumber: z.string().max(80).default(''),
  notes: z.string().max(10000).default(''),
});
export const CreateProjectBody = ProjectFields;
export const UpdateProjectBody = ProjectFields.partial().extend({
  extraWireFt: z.number().min(0).max(1000).optional(),
  markerScale: z.number().min(0.5).max(2).optional(),
  snapToLines: z.boolean().optional(),
  archived: z.boolean().optional(),
  restore: z.boolean().optional(),
});
export const DuplicateProjectBody = z.object({
  name: z.string().trim().min(1).max(200),
  withMarkers: z.boolean(),
});

export const Floor = z.object({
  id: Id,
  projectId: Id,
  name: z.string(),
  sheetNumber: z.string(),
  sortOrder: z.number(),
  imageUrl: z.string(),
  previewUrl: z.string(),
  thumbUrl: z.string(),
  widthPx: z.number(),
  heightPx: z.number(),
  previewWidthPx: z.number(),
  /** DPI the sheet was rendered at (PDF pages), used to derive feet/px from a drawing scale */
  renderDpi: z.number().nullable(),
  /** real feet per sheet pixel; null until a scale is set or calibrated */
  ftPerPx: z.number().nullable(),
  scaleLabel: z.string(),
  floorHeightFt: z.number(),
  riserX: z.number().nullable(),
  riserY: z.number().nullable(),
  updatedAt: ts,
});
export type Floor = z.infer<typeof Floor>;
export const UpdateFloorBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sheetNumber: z.string().max(40).optional(),
  ftPerPx: z.number().positive().max(100).nullable().optional(),
  scaleLabel: z.string().max(60).optional(),
  renderDpi: z.number().int().min(36).max(1200).nullable().optional(),
  floorHeightFt: z.number().min(0).max(100).optional(),
  riserX: z.number().min(0).max(1).nullable().optional(),
  riserY: z.number().min(0).max(1).nullable().optional(),
});
export const ReorderFloorsBody = z.object({ floorIds: z.array(Id).min(1) });

export const SheetRevision = z.object({
  id: Id,
  floorId: Id,
  imageUrl: z.string(),
  widthPx: z.number(),
  heightPx: z.number(),
  uploadedBy: z.string().nullable(),
  uploadedAt: ts,
});

export const UploadPage = z.object({
  page: z.number(),
  floorId: Id.nullable(),
  name: z.string(),
  sheetNumber: z.string(),
  thumbUrl: z.string().nullable(),
  widthPx: z.number(),
  heightPx: z.number(),
});
export const Upload = z.object({
  id: Id,
  projectId: Id,
  kind: z.enum(['pdf', 'image']),
  filename: z.string(),
  pageCount: z.number(),
  pagesDone: z.number(),
  status: z.enum(['queued', 'converting', 'done', 'failed']),
  error: z.string().nullable(),
  pages: z.array(UploadPage),
});
export type Upload = z.infer<typeof Upload>;
export const PickPagesBody = z.object({ keepPages: z.array(z.number().int().min(1)) });

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const Code = z.string().regex(/^[A-Z]{1,6}$/, 'Code must be 1–6 uppercase letters');

/** Coverage defaults for a device type (e.g. a camera's field of view, a WAP's range). */
export const TypeCoverage = z.object({
  defaultOn: z.boolean(),
  rangeFt: z.number().min(1).max(1000),
  angleDeg: z.number().min(5).max(360),
});
export type TypeCoverage = z.infer<typeof TypeCoverage>;
/** Per-device coverage overrides; unset fields follow the type. dirDeg is clockwise from up. */
export const MarkerCoverage = z.object({
  on: z.boolean().optional(),
  rangeFt: z.number().min(1).max(1000).optional(),
  angleDeg: z.number().min(5).max(360).optional(),
  dirDeg: z.number().min(-720).max(720).optional(),
});
export type MarkerCoverage = z.infer<typeof MarkerCoverage>;

export const Category = z.object({ id: Id, name: z.string(), color: HexColor, sortOrder: z.number() });
export type Category = z.infer<typeof Category>;
export const DeviceType = z.object({
  id: Id,
  categoryId: Id,
  code: Code,
  name: z.string(),
  defaultModel: z.string(),
  defaultNotes: z.string(),
  sortOrder: z.number(),
  retiredAt: ts.nullable(),
  inUse: z.number(),
  wires: z.array(z.object({ wireTypeId: Id, count: z.number().int().min(1).max(20) })),
  /** null = this type has no coverage area */
  coverage: TypeCoverage.nullable(),
  /** optional icon drawn instead of the code tag; null = use the tag */
  iconUrl: z.string().nullable(),
  /** with an icon: print code + number below it by default */
  iconLabel: z.boolean(),
});
export type DeviceType = z.infer<typeof DeviceType>;
export const WireType = z.object({ id: Id, name: z.string(), sortOrder: z.number(), inUse: z.number() });
export type WireType = z.infer<typeof WireType>;
/** Admin-managed zone names offered as autocomplete when naming zones and rooms. */
export const ZoneName = z.object({ id: Id, name: z.string(), sortOrder: z.number() });
export type ZoneName = z.infer<typeof ZoneName>;
/** How strongly zone corners snap: the pull distance in screen pixels; 0 turns that snap off. */
const SnapPx = z.number().int().min(0).max(60);
export const SnapSettings = z.object({
  cornerPx: SnapPx,
  edgePx: SnapPx,
  /** degrees from horizontal or vertical within which an edge straightens */
  axisDeg: z.number().min(0).max(15),
  linePx: SnapPx,
});
export type SnapSettings = z.infer<typeof SnapSettings>;
const SheetLineRow = z.tuple([z.number(), z.number(), z.number()]);
export const SheetLinesDto = z.object({ h: z.array(SheetLineRow), v: z.array(SheetLineRow) });
export const Library = z.object({
  categories: z.array(Category),
  types: z.array(DeviceType),
  wireTypes: z.array(WireType),
  zoneNames: z.array(ZoneName),
  snap: SnapSettings,
});
export type Library = z.infer<typeof Library>;

export const CreateCategoryBody = z.object({ name: z.string().trim().min(1).max(60), color: HexColor });
export const UpdateCategoryBody = CreateCategoryBody.partial().extend({
  sortOrder: z.number().int().optional(),
});
export const CreateTypeBody = z.object({
  categoryId: Id,
  code: Code,
  name: z.string().trim().min(1).max(80),
  defaultModel: z.string().max(200).default(''),
  defaultNotes: z.string().max(2000).default(''),
  coverage: TypeCoverage.nullable().optional(),
  iconLabel: z.boolean().optional(),
});
export const UpdateTypeBody = CreateTypeBody.partial().extend({
  sortOrder: z.number().int().optional(),
  retired: z.boolean().optional(),
  wires: z
    .array(z.object({ wireTypeId: Id, count: z.number().int().min(1).max(20) }))
    .max(20)
    .optional(),
});
export const WireTypeBody = z.object({ name: z.string().trim().min(1).max(60) });
export const ZoneNameBody = z.object({ name: z.string().trim().min(1).max(120) });
export const ReorderBody = z.object({ ids: z.array(Id).min(1) });

const frac = z.number().min(0).max(1);
export const Marker = z.object({
  id: Id,
  projectId: Id,
  floorId: Id,
  typeId: Id,
  number: z.number().int(),
  x: z.number(),
  y: z.number(),
  room: z.string(),
  mountHeight: z.string(),
  notes: z.string(),
  /** equipment closet override; null = the project's first closet */
  closetZoneId: Id.nullable(),
  /** coverage overrides; null = all type defaults */
  coverage: MarkerCoverage.nullable(),
  /** with an icon: print code + number below it; null = the type's default */
  iconLabel: z.boolean().nullable(),
  createdBy: Id.nullable(),
  updatedBy: Id.nullable(),
  updatedAt: ts,
});
export type Marker = z.infer<typeof Marker>;

export const ZoneKind = z.enum(['room', 'closet']);
export const AudioFormatSchema = z.enum(['stereo', '5.0', '5.1', '7.1']);
const Point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export const Zone = z.object({
  id: Id,
  projectId: Id,
  floorId: Id,
  name: z.string(),
  kind: ZoneKind,
  points: z.array(Point),
  audioFormat: AudioFormatSchema.nullable(),
  /** false = don't print the name on the plan or PDF (e.g. the drawing already shows it) */
  showName: z.boolean(),
  updatedAt: ts,
});
export type Zone = z.infer<typeof Zone>;
/** PUT /api/zones/:id — upsert by client UUID */
export const PutZoneBody = z.object({
  projectId: Id,
  floorId: Id,
  name: z.string().trim().min(1).max(120),
  kind: ZoneKind,
  points: z.array(Point).min(3).max(200),
  audioFormat: AudioFormatSchema.nullable().default(null),
  showName: z.boolean().optional(),
});

export const MarkerFields = z.object({
  floorId: Id,
  typeId: Id,
  x: frac,
  y: frac,
  room: z.string().max(200).default(''),
  mountHeight: z.string().max(80).default(''),
  notes: z.string().max(5000).default(''),
  closetZoneId: Id.nullable().optional(),
  coverage: MarkerCoverage.nullable().optional(),
  iconLabel: z.boolean().nullable().optional(),
});

/** PUT /api/markers/:id — upsert by client UUID. Omit `number` (or set autoNumber) to have the server assign it. */
export const PutMarkerBody = MarkerFields.extend({
  projectId: Id,
  number: z.number().int().min(1).max(99999).optional(),
  autoNumber: z.boolean().optional(),
  restore: z.boolean().optional(),
});
export type PutMarkerBody = z.infer<typeof PutMarkerBody>;

export const MarkerPatch = MarkerFields.partial().extend({
  id: Id,
  number: z.number().int().min(1).max(99999).optional(),
  autoNumber: z.boolean().optional(),
});
export type MarkerPatch = z.infer<typeof MarkerPatch>;
export const BatchMarkersBody = z.object({
  projectId: Id,
  updates: z.array(MarkerPatch).max(2000).default([]),
  creates: z
    .array(PutMarkerBody.extend({ id: Id }))
    .max(2000)
    .default([]),
  deletes: z.array(Id).max(2000).default([]),
});
export type BatchMarkersBody = z.infer<typeof BatchMarkersBody>;
export const BatchMarkersResponse = z.object({
  markers: z.array(Marker),
  rejected: z.array(Id),
  deleted: z.array(Id),
});

export const RenumberBody = z.object({ typeId: Id.nullable(), apply: z.boolean() });
export const RenumberResponse = z.object({
  changes: z.array(
    z.object({
      id: Id,
      typeId: Id,
      floorId: Id,
      oldTag: z.string(),
      newTag: z.string(),
      oldNumber: z.number(),
      newNumber: z.number(),
    }),
  ),
  applied: z.boolean(),
});

export const Activity = z.object({
  id: z.number(),
  userName: z.string().nullable(),
  markerId: Id.nullable(),
  action: z.string(),
  summary: z.string(),
  at: ts,
});
export type Activity = z.infer<typeof Activity>;

export const ApiToken = z.object({
  id: Id,
  name: z.string(),
  createdAt: ts,
  revokedAt: ts.nullable(),
  token: z.string().optional(),
});
export const CreateTokenBody = z.object({ name: z.string().trim().min(1).max(80) });

export const PresenceUser = z.object({
  userId: Id,
  name: z.string(),
  initials: z.string(),
  clientId: z.string(),
});
export type PresenceUser = z.infer<typeof PresenceUser>;

/** SSE events on /api/projects/:id/events (R-51). `origin` is the X-Client-Id of the writer. */
export type ProjectEvent =
  | { type: 'marker.upsert'; origin: string | null; markers: Marker[] }
  | { type: 'marker.delete'; origin: string | null; ids: string[] }
  | { type: 'floor.upsert'; origin: string | null; floors: Floor[] }
  | { type: 'floor.delete'; origin: string | null; ids: string[]; markerIds: string[] }
  | { type: 'floor.order'; origin: string | null; floorIds: string[] }
  | { type: 'project.update'; origin: string | null; project: Project }
  | { type: 'upload.progress'; origin: string | null; upload: Upload }
  | { type: 'library.update'; origin: string | null }
  | { type: 'zone.upsert'; origin: string | null; zones: Zone[] }
  | { type: 'zone.delete'; origin: string | null; ids: string[] }
  | { type: 'presence'; origin: null; users: PresenceUser[] };

export const ErrorBody = z.object({ error: z.string(), details: z.any().optional() });
