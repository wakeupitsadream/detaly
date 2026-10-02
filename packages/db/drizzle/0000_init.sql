CREATE TYPE "public"."actor_type" AS ENUM('client', 'staff', 'system', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."api_call_source" AS ENUM('rossko', 'yookassa', 'vin', 'sms', 'telegram', 'max');--> statement-breakpoint
CREATE TYPE "public"."cart_status" AS ENUM('active', 'converted', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."claim_decision" AS ENUM('refund', 'replace', 'reject');--> statement-breakpoint
CREATE TYPE "public"."claim_kind" AS ENUM('refusal', 'not_fit', 'defect', 'delay');--> statement-breakpoint
CREATE TYPE "public"."consent_channel" AS ENUM('web', 'telegram', 'max', 'admin');--> statement-breakpoint
CREATE TYPE "public"."consent_kind" AS ENUM('pd', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('offer', 'privacy', 'consent_pd', 'consent_marketing', 'return_memo');--> statement-breakpoint
CREATE TYPE "public"."excluded_kind" AS ENUM('keyword', 'group');--> statement-breakpoint
CREATE TYPE "public"."fulfillment" AS ENUM('pickup', 'courier');--> statement-breakpoint
CREATE TYPE "public"."install_booking_status" AS ENUM('requested', 'confirmed', 'done', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."messenger_channel" AS ENUM('telegram', 'max');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('telegram', 'max', 'sms');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."order_item_state" AS ENUM('pending', 'ordered', 'failed', 'replaced', 'arrived', 'handed', 'return_requested', 'returned', 'refund_pending', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'awaiting_payment', 'awaiting_confirmation', 'confirmed', 'ordering', 'awaiting_supplier_invoice', 'ordered_at_supplier', 'needs_attention', 'awaiting_client_approval', 'ready', 'out_for_delivery', 'awaiting_handover_payment', 'handed', 'completed', 'cancelled', 'refund_pending', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('prepayment', 'full');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('yookassa');--> statement-breakpoint
CREATE TYPE "public"."payment_scheme" AS ENUM('prepay', 'pay_on_handover');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'waiting_for_capture', 'succeeded', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."photo_kind" AS ENUM('packaging', 'handover', 'return');--> statement-breakpoint
CREATE TYPE "public"."receipt_kind" AS ENUM('prepayment', 'full', 'offset', 'refund_prepayment', 'refund_full', 'correction');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('pending', 'succeeded', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."refund_reason" AS ENUM('refusal', 'not_fit', 'defect', 'supplier_fail', 'no_show', 'delay', 'late_payment', 'amount_mismatch', 'other');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('owner', 'seller');--> statement-breakpoint
CREATE TYPE "public"."supplier_order_status" AS ENUM('sending', 'created', 'failed');--> statement-breakpoint
CREATE TYPE "public"."supplier_return_kind" AS ENUM('return', 'claim');--> statement-breakpoint
CREATE TYPE "public"."supplier_return_status" AS ENUM('requested', 'accepted', 'rejected', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."vin_provider" AS ENUM('manual', 'laximo', 'acat', 'partsapi');--> statement-breakpoint
CREATE TYPE "public"."vin_request_status" AS ENUM('new', 'in_work', 'offered', 'converted', 'closed');--> statement-breakpoint
CREATE TYPE "public"."webhook_source" AS ENUM('yookassa', 'max');--> statement-breakpoint
CREATE SEQUENCE "public"."order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 999999 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"kind" "consent_kind" NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" "consent_channel" NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"text_sha256" char(64) NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "consents_text_sha256_check" CHECK ("consents"."text_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "document_kind" NOT NULL,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"sha256" char(64) NOT NULL,
	"source_path" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_kind_version_unique" UNIQUE("kind","version"),
	CONSTRAINT "document_versions_sha256_check" CHECK ("document_versions"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "excluded_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "excluded_kind" NOT NULL,
	"pattern" text NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "excluded_groups_kind_pattern_unique" UNIQUE("kind","pattern"),
	CONSTRAINT "excluded_groups_pattern_check" CHECK (length(btrim("excluded_groups"."pattern")) > 0)
);
--> statement-breakpoint
CREATE TABLE "messenger_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "messenger_channel" NOT NULL,
	"external_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"phone_confirmed_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messenger_bindings_channel_external_user_id_unique" UNIQUE("channel","external_user_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"tg_user_id" bigint,
	"max_user_id" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_tg_user_id_unique" UNIQUE("tg_user_id"),
	CONSTRAINT "staff_max_user_id_unique" UNIQUE("max_user_id"),
	CONSTRAINT "staff_messenger_id_check" CHECK ("staff"."tg_user_id" is not null or "staff"."max_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"email" text,
	"no_show_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anonymized_at" timestamp with time zone,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_no_show_count_check" CHECK ("users"."no_show_count" >= 0),
	CONSTRAINT "users_phone_check" CHECK ("users"."phone" ~ '^(\+[1-9][0-9]{6,14}|anon:.+)$')
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cart_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"article" text NOT NULL,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"stock_id" text NOT NULL,
	"is_local" boolean NOT NULL,
	"eta_date" date,
	"price_supplier_kop" integer NOT NULL,
	"price_client_kop" integer NOT NULL,
	"markup_bp" integer NOT NULL,
	"offer_snapshot" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_qty_check" CHECK ("cart_items"."qty" > 0),
	CONSTRAINT "cart_items_price_supplier_kop_check" CHECK ("cart_items"."price_supplier_kop" >= 0),
	CONSTRAINT "cart_items_price_client_kop_check" CHECK ("cart_items"."price_client_kop" >= 0),
	CONSTRAINT "cart_items_markup_bp_check" CHECK ("cart_items"."markup_bp" >= 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"anon_token" text,
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"proposal_token" text,
	"seller_note" text,
	"vin_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_anon_token_unique" UNIQUE("anon_token"),
	CONSTRAINT "carts_proposal_token_unique" UNIQUE("proposal_token")
);
--> statement-breakpoint
CREATE TABLE "vin_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"phone" text NOT NULL,
	"vin" char(17),
	"car_text" text,
	"need_text" text NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "vin_request_status" DEFAULT 'new' NOT NULL,
	"assigned_staff_id" uuid,
	"proposal_cart_id" uuid,
	"resolver" "vin_provider" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vin_requests_vin_check" CHECK ("vin_requests"."vin" ~ '^[A-HJ-NPR-Z0-9]{17}$')
);
--> statement-breakpoint
CREATE TABLE "link_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"order_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_tokens_token_check" CHECK ("link_tokens"."token" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status",
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"article" text NOT NULL,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"stock_id" text NOT NULL,
	"is_local" boolean NOT NULL,
	"price_supplier_at_order_kop" integer NOT NULL,
	"price_client_kop" integer NOT NULL,
	"markup_bp" integer NOT NULL,
	"eta_date" date,
	"offer_snapshot" jsonb NOT NULL,
	"state" "order_item_state" DEFAULT 'pending' NOT NULL,
	"replaced_by_item_id" uuid,
	"supplier_item_error" jsonb,
	"marking_code" text,
	"refunded_amount_kop" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_qty_check" CHECK ("order_items"."qty" > 0),
	CONSTRAINT "order_items_price_supplier_at_order_kop_check" CHECK ("order_items"."price_supplier_at_order_kop" >= 0),
	CONSTRAINT "order_items_price_client_kop_check" CHECK ("order_items"."price_client_kop" >= 0),
	CONSTRAINT "order_items_refunded_amount_kop_check" CHECK ("order_items"."refunded_amount_kop" >= 0),
	CONSTRAINT "order_items_markup_bp_check" CHECK ("order_items"."markup_bp" >= 0),
	CONSTRAINT "order_items_refunded_amount_le_line_check" CHECK ("order_items"."refunded_amount_kop" <= "order_items"."price_client_kop" * "order_items"."qty")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text DEFAULT ('DT-' || lpad(nextval('order_number_seq')::text, 6, '0')) NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text NOT NULL,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"payment_scheme" "payment_scheme" NOT NULL,
	"fulfillment" "fulfillment" DEFAULT 'pickup' NOT NULL,
	"address" jsonb,
	"subtotal_kop" integer NOT NULL,
	"courier_fee_kop" integer DEFAULT 0 NOT NULL,
	"total_kop" integer NOT NULL,
	"items_hash" text NOT NULL,
	"promised_date" date,
	"pickup_code" text,
	"offer_version_id" uuid,
	"attention_reason" text,
	"confirmed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"ordered_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"handed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"supplier_return_deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_access_token_unique" UNIQUE("access_token"),
	CONSTRAINT "orders_subtotal_kop_check" CHECK ("orders"."subtotal_kop" >= 0),
	CONSTRAINT "orders_courier_fee_kop_check" CHECK ("orders"."courier_fee_kop" >= 0),
	CONSTRAINT "orders_total_kop_check" CHECK ("orders"."total_kop" >= 0),
	CONSTRAINT "orders_total_check" CHECK ("orders"."total_kop" = "orders"."subtotal_kop" + "orders"."courier_fee_kop"),
	CONSTRAINT "orders_number_check" CHECK ("orders"."number" ~ '^DT-[0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" "payment_provider" DEFAULT 'yookassa' NOT NULL,
	"provider_payment_id" text,
	"kind" "payment_kind" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount_kop" integer NOT NULL,
	"method" text,
	"idempotence_key" text NOT NULL,
	"confirmation_url" text,
	"expires_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_payment_id_unique" UNIQUE("provider","provider_payment_id"),
	CONSTRAINT "payments_idempotence_key_unique" UNIQUE("idempotence_key"),
	CONSTRAINT "payments_amount_kop_check" CHECK ("payments"."amount_kop" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid,
	"refund_id" uuid,
	"kind" "receipt_kind" NOT NULL,
	"provider_receipt_id" text,
	"idempotence_key" text NOT NULL,
	"status" "receipt_status" DEFAULT 'pending' NOT NULL,
	"fiscal_document_number" text,
	"request" jsonb,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_idempotence_key_unique" UNIQUE("idempotence_key")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_refund_id" text,
	"amount_kop" integer NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" "refund_reason" NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"idempotence_key" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_idempotence_key_unique" UNIQUE("idempotence_key"),
	CONSTRAINT "refunds_provider_refund_id_unique" UNIQUE("provider_refund_id"),
	CONSTRAINT "refunds_amount_kop_check" CHECK ("refunds"."amount_kop" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_item_id" uuid NOT NULL,
	"cost_kop" integer NOT NULL,
	"reason" text NOT NULL,
	"listed_price_kop" integer,
	"written_off_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_items_cost_kop_check" CHECK ("stock_items"."cost_kop" >= 0),
	CONSTRAINT "stock_items_listed_price_kop_check" CHECK ("stock_items"."listed_price_kop" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_order_items" (
	"supplier_order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	CONSTRAINT "supplier_order_items_supplier_order_id_order_item_id_pk" PRIMARY KEY("supplier_order_id","order_item_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" "supplier_order_status" DEFAULT 'sending' NOT NULL,
	"rossko_order_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"item_errors" jsonb,
	"delivery_cost_kop" integer,
	"status_code" integer,
	"upd_s_3_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_orders_order_id_attempt_no_unique" UNIQUE("order_id","attempt_no"),
	CONSTRAINT "supplier_orders_attempt_no_check" CHECK ("supplier_orders"."attempt_no" >= 1),
	CONSTRAINT "supplier_orders_delivery_cost_kop_check" CHECK ("supplier_orders"."delivery_cost_kop" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_item_id" uuid NOT NULL,
	"kind" "supplier_return_kind" NOT NULL,
	"status" "supplier_return_status" DEFAULT 'requested' NOT NULL,
	"amount_expected_kop" integer,
	"amount_received_kop" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_returns_amount_expected_kop_check" CHECK ("supplier_returns"."amount_expected_kop" >= 0),
	CONSTRAINT "supplier_returns_amount_received_kop_check" CHECK ("supplier_returns"."amount_received_kop" >= 0)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid,
	"kind" "claim_kind" NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"decision" "claim_decision",
	"decision_text" text,
	"compensation_amount_kop" integer,
	"return_accepted_at" timestamp with time zone,
	"decided_by" uuid,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_compensation_amount_kop_check" CHECK ("claims"."compensation_amount_kop" >= 0)
);
--> statement-breakpoint
CREATE TABLE "install_bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"status" "install_booking_status" DEFAULT 'requested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "photo_kind" NOT NULL,
	"s3_key" text NOT NULL,
	"by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" "api_call_source" NOT NULL,
	"method" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"cost_kop" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_calls_duration_ms_check" CHECK ("api_calls"."duration_ms" >= 0),
	CONSTRAINT "api_calls_cost_kop_check" CHECK ("api_calls"."cost_kop" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"staff_id" uuid,
	"order_id" uuid,
	"channel" "notification_channel",
	"template" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"fallback_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notifications_recipient_check" CHECK ("notifications"."user_id" is not null or "notifications"."staff_id" is not null),
	CONSTRAINT "notifications_attempts_check" CHECK ("notifications"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "search_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"brand" text,
	"article" text,
	"results_count" integer NOT NULL,
	"from_cache" boolean NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_log_results_count_check" CHECK ("search_log"."results_count" >= 0),
	CONSTRAINT "search_log_latency_ms_check" CHECK ("search_log"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" "webhook_source" NOT NULL,
	"external_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"result" text,
	CONSTRAINT "webhook_events_source_external_id_event_type_unique" UNIQUE("source","external_id","event_type")
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_bindings" ADD CONSTRAINT "messenger_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_vin_request_id_vin_requests_id_fk" FOREIGN KEY ("vin_request_id") REFERENCES "public"."vin_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD CONSTRAINT "vin_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD CONSTRAINT "vin_requests_assigned_staff_id_staff_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vin_requests" ADD CONSTRAINT "vin_requests_proposal_cart_id_carts_id_fk" FOREIGN KEY ("proposal_cart_id") REFERENCES "public"."carts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_tokens" ADD CONSTRAINT "link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_tokens" ADD CONSTRAINT "link_tokens_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_replaced_by_item_id_order_items_id_fk" FOREIGN KEY ("replaced_by_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_offer_version_id_document_versions_id_fk" FOREIGN KEY ("offer_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_items" ADD CONSTRAINT "supplier_order_items_supplier_order_id_supplier_orders_id_fk" FOREIGN KEY ("supplier_order_id") REFERENCES "public"."supplier_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_items" ADD CONSTRAINT "supplier_order_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_decided_by_staff_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_bookings" ADD CONSTRAINT "install_bookings_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_bookings" ADD CONSTRAINT "install_bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_by_staff_id_staff_id_fk" FOREIGN KEY ("by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_user_id_kind_idx" ON "consents" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "document_versions_kind_published_at_idx" ON "document_versions" USING btree ("kind","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_bindings_user_id_primary_unique" ON "messenger_bindings" USING btree ("user_id") WHERE "messenger_bindings"."is_primary";--> statement-breakpoint
CREATE INDEX "cart_items_cart_id_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "carts_user_id_idx" ON "carts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vin_requests_status_created_at_idx" ON "vin_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "link_tokens_expires_at_idx" ON "link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "order_events_order_id_created_at_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_status_expires_at_idx" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "orders_user_id_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_id_succeeded_unique" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'succeeded';--> statement-breakpoint
CREATE INDEX "payments_order_id_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_status_created_at_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "receipts_order_id_idx" ON "receipts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_status_deadline_at_idx" ON "refunds" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "refunds_order_id_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "stock_items_order_item_id_idx" ON "stock_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "supplier_order_items_order_item_id_idx" ON "supplier_order_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "supplier_returns_order_item_id_idx" ON "supplier_returns" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "claims_deadline_at_open_idx" ON "claims" USING btree ("deadline_at") WHERE "claims"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "claims_order_id_idx" ON "claims" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "install_bookings_slot_at_idx" ON "install_bookings" USING btree ("slot_at");--> statement-breakpoint
CREATE INDEX "install_bookings_order_id_idx" ON "install_bookings" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_photos_order_id_idx" ON "order_photos" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "api_calls_source_created_at_idx" ON "api_calls" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "notifications_order_id_idx" ON "notifications" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "search_log_created_at_idx" ON "search_log" USING btree ("created_at");