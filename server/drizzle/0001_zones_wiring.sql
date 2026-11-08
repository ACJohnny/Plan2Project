CREATE TABLE "device_type_wires" (
	"type_id" uuid NOT NULL,
	"wire_type_id" uuid NOT NULL,
	"count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wire_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "wire_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'room' NOT NULL,
	"points" jsonb NOT NULL,
	"audio_format" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "floors" ADD COLUMN "render_dpi" integer;--> statement-breakpoint
ALTER TABLE "floors" ADD COLUMN "ft_per_px" double precision;--> statement-breakpoint
ALTER TABLE "floors" ADD COLUMN "scale_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "floors" ADD COLUMN "floor_height_ft" double precision DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "floors" ADD COLUMN "riser_x" double precision;--> statement-breakpoint
ALTER TABLE "floors" ADD COLUMN "riser_y" double precision;--> statement-breakpoint
ALTER TABLE "markers" ADD COLUMN "closet_zone_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "extra_wire_ft" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "device_type_wires" ADD CONSTRAINT "device_type_wires_type_id_device_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."device_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_type_wires" ADD CONSTRAINT "device_type_wires_wire_type_id_wire_types_id_fk" FOREIGN KEY ("wire_type_id") REFERENCES "public"."wire_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_type_wires_uq" ON "device_type_wires" USING btree ("type_id","wire_type_id");--> statement-breakpoint
CREATE INDEX "zones_project_idx" ON "zones" USING btree ("project_id","deleted_at");--> statement-breakpoint
UPDATE "floors" SET "render_dpi" = 150 WHERE "upload_id" IN (SELECT "id" FROM "uploads" WHERE "kind" = 'pdf');
