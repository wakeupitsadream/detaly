CREATE TABLE "price_benchmarks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand" text NOT NULL,
	"article" text NOT NULL,
	"price_group" text NOT NULL,
	"competitor" text NOT NULL,
	"competitor_price_kop" integer NOT NULL,
	"competitor_delivery_kop" integer DEFAULT 0 NOT NULL,
	"competitor_eta_days" integer,
	"source_url" text,
	"note" text,
	"our_supplier_kop" integer,
	"our_price_kop" integer,
	"our_is_local" boolean,
	"our_eta_days" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_by" text NOT NULL,
	CONSTRAINT "price_benchmarks_article_check" CHECK ("price_benchmarks"."article" ~ '^[A-Z0-9]{1,64}$'),
	CONSTRAINT "price_benchmarks_brand_check" CHECK (length(btrim("price_benchmarks"."brand")) between 1 and 64),
	CONSTRAINT "price_benchmarks_price_group_check" CHECK ("price_benchmarks"."price_group" in ('filters', 'brakes', 'suspension', 'ignition', 'timing', 'bearings', 'clutch', 'cooling', 'wipers', 'lighting', 'engine', 'body', 'other')),
	CONSTRAINT "price_benchmarks_competitor_check" CHECK ("price_benchmarks"."competitor" in ('emex', 'exist', 'autodoc', 'rossko_retail', 'avito', 'other')),
	CONSTRAINT "price_benchmarks_competitor_price_kop_check" CHECK ("price_benchmarks"."competitor_price_kop" > 0),
	CONSTRAINT "price_benchmarks_competitor_delivery_kop_check" CHECK ("price_benchmarks"."competitor_delivery_kop" >= 0),
	CONSTRAINT "price_benchmarks_competitor_eta_days_check" CHECK ("price_benchmarks"."competitor_eta_days" is null or "price_benchmarks"."competitor_eta_days" between 0 and 365),
	CONSTRAINT "price_benchmarks_our_snapshot_check" CHECK (("price_benchmarks"."our_supplier_kop" is null and "price_benchmarks"."our_price_kop" is null and "price_benchmarks"."our_is_local" is null and "price_benchmarks"."our_eta_days" is null) or ("price_benchmarks"."our_supplier_kop" is not null and "price_benchmarks"."our_price_kop" is not null and "price_benchmarks"."our_is_local" is not null and "price_benchmarks"."our_eta_days" is not null and "price_benchmarks"."our_supplier_kop" > 0 and "price_benchmarks"."our_price_kop" > 0 and "price_benchmarks"."our_eta_days" >= 0)),
	CONSTRAINT "price_benchmarks_source_url_check" CHECK ("price_benchmarks"."source_url" is null or length("price_benchmarks"."source_url") <= 500),
	CONSTRAINT "price_benchmarks_note_check" CHECK ("price_benchmarks"."note" is null or length("price_benchmarks"."note") <= 300),
	CONSTRAINT "price_benchmarks_captured_by_check" CHECK (length(btrim("price_benchmarks"."captured_by")) > 0)
);
--> statement-breakpoint
CREATE TABLE "settings_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_audit_changed_by_check" CHECK (length(btrim("settings_audit"."changed_by")) > 0)
);
--> statement-breakpoint
CREATE INDEX "price_benchmarks_captured_at_idx" ON "price_benchmarks" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "price_benchmarks_price_group_captured_at_idx" ON "price_benchmarks" USING btree ("price_group","captured_at");--> statement-breakpoint
CREATE INDEX "settings_audit_key_changed_at_idx" ON "settings_audit" USING btree ("key","changed_at");