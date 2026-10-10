ALTER TYPE "public"."supplier_return_status" ADD VALUE 'shipped';--> statement-breakpoint
CREATE TABLE "finance_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "finance_reconciliations_month_check" CHECK ("finance_reconciliations"."month" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "finance_reconciliations_created_by_check" CHECK (length(btrim("finance_reconciliations"."created_by")) between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD COLUMN "shipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "finance_reconciliations_month_created_at_idx" ON "finance_reconciliations" USING btree ("month","created_at");--> statement-breakpoint
CREATE INDEX "order_events_type_created_at_idx" ON "order_events" USING btree ("type","created_at");--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_shipped_check" CHECK ("supplier_returns"."status"::text <> 'shipped' or "supplier_returns"."shipped_at" is not null);--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_refunded_check" CHECK ("supplier_returns"."status"::text <> 'refunded' or ("supplier_returns"."refunded_at" is not null and "supplier_returns"."amount_received_kop" is not null));