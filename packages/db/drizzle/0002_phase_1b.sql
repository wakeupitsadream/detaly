CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'refund', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('alternative', 'new_eta');--> statement-breakpoint
CREATE TYPE "public"."refund_scope" AS ENUM('order', 'item', 'orphan');--> statement-breakpoint
CREATE TABLE "client_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid,
	"kind" "approval_kind" NOT NULL,
	"scope" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"created_by_staff_id" uuid,
	"notified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision" "approval_decision",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_approvals_scope_check" CHECK ("client_approvals"."scope" in ('order', 'item')),
	CONSTRAINT "client_approvals_scope_item_check" CHECK (("client_approvals"."scope" = 'item') = ("client_approvals"."order_item_id" is not null)),
	CONSTRAINT "client_approvals_decision_check" CHECK (("client_approvals"."decided_at" is null) = ("client_approvals"."decision" is null))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"name" text NOT NULL,
	"job_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "outbox_queue_check" CHECK ("outbox"."queue" in ('payments', 'receipts', 'rossko', 'notify', 'reconciliation', 'housekeeping')),
	CONSTRAINT "outbox_attempts_check" CHECK ("outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "seller_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid,
	"chat_id" text NOT NULL,
	"message_id" integer,
	"nonce" text NOT NULL,
	"kind" text NOT NULL,
	"order_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "seller_cards_nonce_unique" UNIQUE("nonce"),
	CONSTRAINT "seller_cards_nonce_check" CHECK ("seller_cards"."nonce" ~ '^[A-Za-z0-9_-]{8}$'),
	CONSTRAINT "seller_cards_kind_check" CHECK ("seller_cards"."kind" in ('order', 'qr'))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_recipient_check";--> statement-breakpoint
DROP INDEX "payments_order_id_succeeded_unique";--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "client_arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "confirmation_type" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "confirmation_data" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "request" jsonb;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "first_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "scope" "refund_scope" DEFAULT 'order' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "request" jsonb;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "called_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "recovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "invoice_amount_kop" integer;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "invoice_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "invoice_payment_ref" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "ip" "inet";--> statement-breakpoint
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_cards" ADD CONSTRAINT "seller_cards_order_event_id_order_events_id_fk" FOREIGN KEY ("order_event_id") REFERENCES "public"."order_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_approvals_order_open_unique" ON "client_approvals" USING btree ("order_id") WHERE "client_approvals"."decided_at" is null;--> statement-breakpoint
CREATE INDEX "client_approvals_expires_at_open_idx" ON "client_approvals" USING btree ("expires_at") WHERE "client_approvals"."decided_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("available_at") WHERE "outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "seller_cards_order_id_open_idx" ON "seller_cards" USING btree ("order_id") WHERE "seller_cards"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "payments_order_id_status_idx" ON "payments" USING btree ("order_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_order_offset_unique" ON "receipts" USING btree ("order_id") WHERE "receipts"."kind" = 'offset' and "receipts"."status" <> 'canceled';--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_payment_kind_unique" ON "receipts" USING btree ("payment_id","kind") WHERE "receipts"."kind" in ('prepayment', 'full');--> statement-breakpoint
CREATE INDEX "refunds_payment_id_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_orders_order_sending_unique" ON "supplier_orders" USING btree ("order_id") WHERE "supplier_orders"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" is null;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmation_type_check" CHECK ("payments"."confirmation_type" in ('redirect', 'qr'));--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_attempts_check" CHECK ("receipts"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_invoice_amount_kop_check" CHECK ("supplier_orders"."invoice_amount_kop" >= 0);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_check" CHECK ("notifications"."user_id" is not null or "notifications"."staff_id" is not null or "notifications"."chat_id" is not null);