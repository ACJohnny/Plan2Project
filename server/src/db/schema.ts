import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { MarkerCoverage, TypeCoverage } from '@sixpoint/shared';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => tstz('created_at').notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: ['admin', 'editor', 'viewer'] }).notNull(),
    passwordHash: text('password_hash').notNull(),
    active: boolean('active').notNull().default(true),
    theme: text('theme', { enum: ['system', 'light', 'dark'] })
      .notNull()
      .default('system'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the cookie value */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrf: text('csrf').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
  revokedAt: tstz('revoked_at'),
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    client: text('client').notNull().default(''),
    address: text('address').notNull().default(''),
    jobNumber: text('job_number').notNull().default(''),
    notes: text('notes').notNull().default(''),
    archivedAt: tstz('archived_at'),
    deletedAt: tstz('deleted_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    /** extra wire added to every cable run, feet */
    extraWireFt: doublePrecision('extra_wire_ft').notNull().default(0),
    /** Phase 2: tokenized read-only share link */
    shareToken: text('share_token').unique(),
  },
  (t) => [index('projects_deleted_idx').on(t.deletedAt, t.archivedAt)],
);

export const floors = pgTable(
  'floors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sheetNumber: text('sheet_number').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    /** paths are relative to DATA_DIR */
    imagePath: text('image_path').notNull(),
    previewPath: text('preview_path').notNull(),
    thumbPath: text('thumb_path').notNull(),
    widthPx: integer('width_px').notNull(),
    heightPx: integer('height_px').notNull(),
    previewWidthPx: integer('preview_width_px').notNull(),
    renderDpi: integer('render_dpi'),
    ftPerPx: doublePrecision('ft_per_px'),
    scaleLabel: text('scale_label').notNull().default(''),
    floorHeightFt: doublePrecision('floor_height_ft').notNull().default(10),
    riserX: doublePrecision('riser_x'),
    riserY: doublePrecision('riser_y'),
    uploadId: uuid('upload_id'),
    uploadPage: integer('upload_page'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [index('floors_project_idx').on(t.projectId, t.deletedAt)],
);

export const sheetRevisions = pgTable('sheet_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  floorId: uuid('floor_id')
    .notNull()
    .references(() => floors.id, { onDelete: 'cascade' }),
  imagePath: text('image_path').notNull(),
  previewPath: text('preview_path').notNull(),
  thumbPath: text('thumb_path').notNull(),
  widthPx: integer('width_px').notNull(),
  heightPx: integer('height_px').notNull(),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  uploadedAt: tstz('uploaded_at').notNull(),
});

export interface UploadPageRow {
  page: number;
  floorId: string | null;
  name: string;
  sheetNumber: string;
  thumbPath: string | null;
  widthPx: number;
  heightPx: number;
  /** full sheet files, kept for staged sheet replacements */
  imagePath?: string;
  previewPath?: string;
  fullThumbPath?: string;
  previewWidthPx?: number;
}

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  originalPath: text('original_path').notNull(),
  filename: text('filename').notNull().default(''),
  kind: text('kind', { enum: ['pdf', 'image'] }).notNull(),
  pageCount: integer('page_count').notNull().default(0),
  pagesDone: integer('pages_done').notNull().default(0),
  status: text('status', { enum: ['queued', 'converting', 'done', 'failed'] })
    .notNull()
    .default('queued'),
  error: text('error'),
  pages: jsonb('pages').$type<UploadPageRow[]>().notNull().default([]),
  /** set when the floor is replaced rather than created */
  targetFloorId: uuid('target_floor_id'),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
});

export const deviceCategories = pgTable('device_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  colorHex: text('color_hex').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const deviceTypes = pgTable(
  'device_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => deviceCategories.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    defaultModel: text('default_model').notNull().default(''),
    defaultNotes: text('default_notes').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    retiredAt: tstz('retired_at'),
    coverage: jsonb('coverage').$type<TypeCoverage>(),
  },
  (t) => [uniqueIndex('device_types_code_uq').on(t.code)],
);

export const markers = pgTable(
  'markers',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    floorId: uuid('floor_id')
      .notNull()
      .references(() => floors.id, { onDelete: 'cascade' }),
    typeId: uuid('type_id')
      .notNull()
      .references(() => deviceTypes.id),
    number: integer('number').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    room: text('room').notNull().default(''),
    mountHeight: text('mount_height').notNull().default(''),
    notes: text('notes').notNull().default(''),
    closetZoneId: uuid('closet_zone_id'),
    coverage: jsonb('coverage').$type<MarkerCoverage>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    index('markers_project_deleted_idx').on(t.projectId, t.deletedAt),
    index('markers_project_type_number_idx').on(t.projectId, t.typeId, t.number),
  ],
);

export const activity = pgTable(
  'activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    markerId: uuid('marker_id'),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('activity_project_idx').on(t.projectId, t.at)],
);

export const wireTypes = pgTable('wire_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const zoneNames = pgTable(
  'zone_names',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('zone_names_name_uq').on(sql`lower(${t.name})`)],
);

export const deviceTypeWires = pgTable(
  'device_type_wires',
  {
    typeId: uuid('type_id')
      .notNull()
      .references(() => deviceTypes.id, { onDelete: 'cascade' }),
    wireTypeId: uuid('wire_type_id')
      .notNull()
      .references(() => wireTypes.id, { onDelete: 'cascade' }),
    count: integer('count').notNull().default(1),
  },
  (t) => [uniqueIndex('device_type_wires_uq').on(t.typeId, t.wireTypeId)],
);

/** Zones (rooms and equipment closets). Points are 0–1 sheet fractions. */
export const zones = pgTable(
  'zones',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    floorId: uuid('floor_id')
      .notNull()
      .references(() => floors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['room', 'closet'] })
      .notNull()
      .default('room'),
    points: jsonb('points').$type<[number, number][]>().notNull(),
    audioFormat: text('audio_format', { enum: ['stereo', '5.0', '5.1', '7.1'] }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [index('zones_project_idx').on(t.projectId, t.deletedAt)],
);
