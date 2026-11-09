ALTER TABLE "device_types" ADD COLUMN "icon_path" text;--> statement-breakpoint
ALTER TABLE "device_types" ADD COLUMN "icon_label" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "markers" ADD COLUMN "icon_label" boolean;