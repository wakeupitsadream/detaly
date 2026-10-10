ALTER TABLE "supplier_orders" ADD COLUMN "status_name" text;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "status_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "rossko_statuses" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_rossko_statuses_check" CHECK (jsonb_typeof("supplier_orders"."rossko_statuses") = 'object');