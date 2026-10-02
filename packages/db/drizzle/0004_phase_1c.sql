ALTER TABLE "seller_cards" DROP CONSTRAINT "seller_cards_kind_check";--> statement-breakpoint
ALTER TABLE "seller_cards" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "vin_request_id" uuid;--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "proposal_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "channel" "notification_channel";--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "request_key" uuid;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "answer_text" text;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "preview" jsonb;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "photos_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD COLUMN "proposal_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "link_tokens" ADD COLUMN "channel" "messenger_channel" DEFAULT 'telegram' NOT NULL;--> statement-breakpoint
ALTER TABLE "link_tokens" ADD COLUMN "used_by_external_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "vin_request_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "client_text" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "opened_via" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "request_key" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "decided_via" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "override_reason" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "replacement_note" text;--> statement-breakpoint
ALTER TABLE "install_bookings" ADD COLUMN "request_key" uuid;--> statement-breakpoint
ALTER TABLE "install_bookings" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "install_bookings" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "install_bookings" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "install_bookings" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "install_bookings" ADD COLUMN "staff_note" text;--> statement-breakpoint
ALTER TABLE "order_photos" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "order_photos" ADD COLUMN "order_item_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "vin_request_id" uuid;--> statement-breakpoint
ALTER TABLE "seller_cards" ADD COLUMN "vin_request_id" uuid;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_vin_request_id_vin_requests_id_fk" FOREIGN KEY ("vin_request_id") REFERENCES "public"."vin_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_vin_request_id_vin_requests_id_fk" FOREIGN KEY ("vin_request_id") REFERENCES "public"."vin_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_vin_request_id_vin_requests_id_fk" FOREIGN KEY ("vin_request_id") REFERENCES "public"."vin_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_vin_request_id_vin_requests_id_fk" FOREIGN KEY ("vin_request_id") REFERENCES "public"."vin_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_vin_request_id_idx" ON "consents" USING btree ("vin_request_id");--> statement-breakpoint
CREATE INDEX "vin_requests_open_created_at_idx" ON "vin_requests" USING btree ("created_at") WHERE "vin_requests"."status" in ('new', 'in_work');--> statement-breakpoint
CREATE INDEX "link_tokens_user_id_idx" ON "link_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_vin_request_id_idx" ON "orders" USING btree ("vin_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_open_target_unique" ON "claims" USING btree ("order_id",coalesce("order_item_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "claims"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "install_bookings_order_active_unique" ON "install_bookings" USING btree ("order_id") WHERE "install_bookings"."status" in ('requested', 'confirmed');--> statement-breakpoint
CREATE INDEX "order_photos_claim_id_idx" ON "order_photos" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "notifications_vin_request_id_idx" ON "notifications" USING btree ("vin_request_id");--> statement-breakpoint
CREATE INDEX "seller_cards_vin_request_id_open_idx" ON "seller_cards" USING btree ("vin_request_id") WHERE "seller_cards"."closed_at" is null;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD CONSTRAINT "vin_requests_request_key_unique" UNIQUE("request_key");--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_request_key_unique" UNIQUE("request_key");--> statement-breakpoint
ALTER TABLE "install_bookings" ADD CONSTRAINT "install_bookings_request_key_unique" UNIQUE("request_key");--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_proposal_expires_at_check" CHECK (("carts"."proposal_token" is null) = ("carts"."proposal_expires_at" is null));--> statement-breakpoint
ALTER TABLE "vin_requests" ADD CONSTRAINT "vin_requests_photos_check" CHECK (case when jsonb_typeof("vin_requests"."photos") = 'array' then jsonb_array_length("vin_requests"."photos") <= 3 else false end);--> statement-breakpoint
ALTER TABLE "vin_requests" ADD CONSTRAINT "vin_requests_proposal_count_check" CHECK ("vin_requests"."proposal_count" >= 0);--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_deadline_check" CHECK ("claims"."deadline_at" = "claims"."opened_at" + interval '240 hours');--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_decision_text_check" CHECK ("claims"."decision" is null or ("claims"."decided_at" is not null and coalesce(length(btrim("claims"."decision_text")), 0) between 1 and 2000));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_override_reason_check" CHECK ("claims"."override_reason" is null or ("claims"."decision" is not null and "claims"."decision" = 'refund' and length(btrim("claims"."override_reason")) > 0));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_client_text_check" CHECK (length("claims"."client_text") <= 1000);--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_opened_via_check" CHECK ("claims"."opened_via" in ('web', 'admin', 'bot'));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_decided_via_check" CHECK ("claims"."decided_via" in ('bot', 'admin'));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_photos_check" CHECK (case when jsonb_typeof("claims"."photos") = 'array' then jsonb_array_length("claims"."photos") <= 3 else false end);--> statement-breakpoint
ALTER TABLE "install_bookings" ADD CONSTRAINT "install_bookings_created_via_check" CHECK ("install_bookings"."created_via" in ('web', 'bot', 'admin'));--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_return_claim_check" CHECK ("order_photos"."kind" <> 'return' or "order_photos"."claim_id" is not null);--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_s3_key_check" CHECK ("order_photos"."s3_key" ~ '^(vin|claim|order)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$');--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_owner_check" CHECK (("seller_cards"."order_id" is null) <> ("seller_cards"."vin_request_id" is null));--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_vin_owner_check" CHECK (("seller_cards"."kind" = 'vin') = ("seller_cards"."vin_request_id" is not null));--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_kind_check" CHECK ("seller_cards"."kind" in ('order', 'qr', 'vin'));