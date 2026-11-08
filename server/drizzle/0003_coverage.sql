ALTER TABLE "device_types" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
ALTER TABLE "markers" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
UPDATE "device_types" SET "coverage" = '{"defaultOn":true,"rangeFt":35,"angleDeg":360}' WHERE "code" = 'WAP' AND "coverage" IS NULL;--> statement-breakpoint
UPDATE "device_types" SET "coverage" = '{"defaultOn":true,"rangeFt":40,"angleDeg":90}' WHERE "code" = 'CAM' AND "coverage" IS NULL;--> statement-breakpoint
UPDATE "device_types" SET "coverage" = '{"defaultOn":true,"rangeFt":15,"angleDeg":150}' WHERE "code" = 'DBL' AND "coverage" IS NULL;--> statement-breakpoint
UPDATE "device_types" SET "coverage" = '{"defaultOn":false,"rangeFt":25,"angleDeg":90}' WHERE "code" = 'SEN' AND "coverage" IS NULL;
