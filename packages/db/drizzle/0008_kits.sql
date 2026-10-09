CREATE TABLE "kit_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kit_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" text,
	"brand" text NOT NULL,
	"article" text NOT NULL,
	"qty" integer NOT NULL,
	"alternative_of" uuid,
	CONSTRAINT "kit_lines_kit_id_position_unique" UNIQUE("kit_id","position"),
	CONSTRAINT "kit_lines_kit_id_id_unique" UNIQUE("kit_id","id"),
	CONSTRAINT "kit_lines_position_check" CHECK ("kit_lines"."position" between 1 and 100),
	CONSTRAINT "kit_lines_qty_check" CHECK ("kit_lines"."qty" between 1 and 99),
	CONSTRAINT "kit_lines_brand_check" CHECK (length(btrim("kit_lines"."brand")) between 1 and 64),
	CONSTRAINT "kit_lines_article_check" CHECK (length(btrim("kit_lines"."article")) between 1 and 64),
	CONSTRAINT "kit_lines_role_check" CHECK ("kit_lines"."role" is null or length(btrim("kit_lines"."role")) between 1 and 60),
	CONSTRAINT "kit_lines_alternative_of_check" CHECK ("kit_lines"."alternative_of" is null or "kit_lines"."alternative_of" <> "kit_lines"."id")
);
--> statement-breakpoint
CREATE TABLE "kits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"make_slug" text NOT NULL,
	"model" text NOT NULL,
	"model_slug" text NOT NULL,
	"engine" text NOT NULL,
	"years_from" integer NOT NULL,
	"years_to" integer,
	"slug" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kits_make_slug_model_slug_slug_unique" UNIQUE("make_slug","model_slug","slug"),
	CONSTRAINT "kits_status_check" CHECK ("kits"."status" in ('draft', 'published')),
	CONSTRAINT "kits_published_at_check" CHECK (("kits"."status" = 'published') = ("kits"."published_at" is not null)),
	CONSTRAINT "kits_make_slug_check" CHECK ("kits"."make_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("kits"."make_slug") <= 64),
	CONSTRAINT "kits_model_slug_check" CHECK ("kits"."model_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("kits"."model_slug") <= 64),
	CONSTRAINT "kits_slug_check" CHECK ("kits"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("kits"."slug") <= 64),
	CONSTRAINT "kits_model_check" CHECK (length(btrim("kits"."model")) between 1 and 60),
	CONSTRAINT "kits_engine_check" CHECK (length(btrim("kits"."engine")) between 1 and 80),
	CONSTRAINT "kits_years_from_check" CHECK ("kits"."years_from" between 1970 and 2100),
	CONSTRAINT "kits_years_to_check" CHECK ("kits"."years_to" is null or "kits"."years_to" between "kits"."years_from" and 2100),
	CONSTRAINT "kits_note_check" CHECK ("kits"."note" is null or length("kits"."note") between 1 and 300),
	CONSTRAINT "kits_created_by_check" CHECK (length(btrim("kits"."created_by")) > 0),
	CONSTRAINT "kits_updated_by_check" CHECK (length(btrim("kits"."updated_by")) > 0)
);
--> statement-breakpoint
ALTER TABLE "kit_lines" ADD CONSTRAINT "kit_lines_kit_id_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."kits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kit_lines" ADD CONSTRAINT "kit_lines_alternative_of_fk" FOREIGN KEY ("kit_id","alternative_of") REFERENCES "public"."kit_lines"("kit_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kit_lines_kit_id_alternative_of_idx" ON "kit_lines" USING btree ("kit_id","alternative_of");--> statement-breakpoint
CREATE INDEX "kits_status_make_slug_model_slug_idx" ON "kits" USING btree ("status","make_slug","model_slug");--> statement-breakpoint
CREATE INDEX "kits_updated_at_idx" ON "kits" USING btree ("updated_at");