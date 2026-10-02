ALTER TABLE "consents" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN "offer_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN "search_article_norm" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "offer_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "search_article_norm" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "preferred_channel" "notification_channel";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_key" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cart_id" uuid;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_order_id_idx" ON "consents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_cart_id_idx" ON "orders" USING btree ("cart_id");--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_offer_key_unique" UNIQUE("cart_id","offer_key");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_key_unique" UNIQUE("checkout_key");--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_search_article_norm_check" CHECK ("cart_items"."search_article_norm" ~ '^[A-Z0-9]{1,64}$');--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_search_article_norm_check" CHECK ("order_items"."search_article_norm" ~ '^[A-Z0-9]{1,64}$');