CREATE TABLE "fit_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cart_id" uuid NOT NULL,
	"cart_item_id" uuid,
	"request_id" uuid NOT NULL,
	"vin" char(17),
	"comment" text,
	"brand" text NOT NULL,
	"article" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"analog_brand" text,
	"analog_article" text,
	"analog_name" text,
	"analog_offer" jsonb,
	"analog_kept_at" timestamp with time zone,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fit_checks_request_id_cart_item_id_unique" UNIQUE("request_id","cart_item_id"),
	CONSTRAINT "fit_checks_status_check" CHECK ("fit_checks"."status" in ('pending', 'fits', 'analog', 'not_fit', 'call_needed', 'expired', 'cancelled')),
	CONSTRAINT "fit_checks_vin_check" CHECK ("fit_checks"."vin" is null or "fit_checks"."vin" ~ '^[A-HJ-NPR-Z0-9]{17}$'),
	CONSTRAINT "fit_checks_comment_check" CHECK ("fit_checks"."comment" is null or length("fit_checks"."comment") between 1 and 200),
	CONSTRAINT "fit_checks_part_check" CHECK (length(btrim("fit_checks"."brand")) > 0 and length(btrim("fit_checks"."article")) > 0),
	CONSTRAINT "fit_checks_answer_check" CHECK (("fit_checks"."answered_at" is not null) = ("fit_checks"."status" in ('fits', 'analog', 'not_fit', 'call_needed')) and ("fit_checks"."answered_by" is null or "fit_checks"."answered_at" is not null)),
	CONSTRAINT "fit_checks_analog_check" CHECK (("fit_checks"."status" = 'analog') = ("fit_checks"."analog_brand" is not null) and ("fit_checks"."analog_brand" is null) = ("fit_checks"."analog_article" is null) and ("fit_checks"."analog_brand" is null) = ("fit_checks"."analog_name" is null) and ("fit_checks"."analog_brand" is null) = ("fit_checks"."analog_offer" is null)),
	CONSTRAINT "fit_checks_analog_kept_check" CHECK ("fit_checks"."analog_kept_at" is null or "fit_checks"."status" = 'analog'),
	CONSTRAINT "fit_checks_expires_at_check" CHECK ("fit_checks"."expires_at" > "fit_checks"."created_at")
);
--> statement-breakpoint
ALTER TABLE "seller_cards" DROP CONSTRAINT "seller_cards_kind_check";--> statement-breakpoint
ALTER TABLE "seller_cards" DROP CONSTRAINT "seller_cards_owner_check";--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fit_check_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fit_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fit_checked_by" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fit_guarantee" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_cards" ADD COLUMN "fit_request_id" uuid;--> statement-breakpoint
ALTER TABLE "fit_checks" ADD CONSTRAINT "fit_checks_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_checks" ADD CONSTRAINT "fit_checks_cart_item_id_cart_items_id_fk" FOREIGN KEY ("cart_item_id") REFERENCES "public"."cart_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_checks" ADD CONSTRAINT "fit_checks_answered_by_staff_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fit_checks_cart_id_created_at_idx" ON "fit_checks" USING btree ("cart_id","created_at");--> statement-breakpoint
CREATE INDEX "fit_checks_cart_item_id_idx" ON "fit_checks" USING btree ("cart_item_id");--> statement-breakpoint
CREATE INDEX "fit_checks_request_id_idx" ON "fit_checks" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "fit_checks_created_at_idx" ON "fit_checks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "fit_checks_pending_created_at_idx" ON "fit_checks" USING btree ("created_at") WHERE "fit_checks"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_fit_check_id_fit_checks_id_fk" FOREIGN KEY ("fit_check_id") REFERENCES "public"."fit_checks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_fit_checked_by_staff_id_fk" FOREIGN KEY ("fit_checked_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_items_fit_check_id_idx" ON "order_items" USING btree ("fit_check_id");--> statement-breakpoint
CREATE INDEX "seller_cards_fit_request_id_open_idx" ON "seller_cards" USING btree ("fit_request_id") WHERE "seller_cards"."closed_at" is null;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_fit_guarantee_check" CHECK (not "order_items"."fit_guarantee" or "order_items"."fit_checked_at" is not null);--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_fit_owner_check" CHECK (("seller_cards"."kind" = 'fit') = ("seller_cards"."fit_request_id" is not null));--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_kind_check" CHECK ("seller_cards"."kind" in ('order', 'qr', 'vin', 'fit'));--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_owner_check" CHECK (num_nonnulls("seller_cards"."order_id", "seller_cards"."vin_request_id", "seller_cards"."fit_request_id") = 1);