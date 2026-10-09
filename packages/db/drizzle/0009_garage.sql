CREATE TABLE "user_vehicles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"make_slug" text,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"engine" text,
	"year" integer,
	"vin" char(17),
	"mileage_km" integer,
	"mileage_at" date,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_vehicles_source_check" CHECK ("user_vehicles"."source" in ('checkout', 'proposal', 'kit', 'handover', 'bot')),
	CONSTRAINT "user_vehicles_vin_check" CHECK ("user_vehicles"."vin" ~ '^[A-HJ-NPR-Z0-9]{17}$'),
	CONSTRAINT "user_vehicles_make_slug_check" CHECK ("user_vehicles"."make_slug" is null or ("user_vehicles"."make_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("user_vehicles"."make_slug") <= 64)),
	CONSTRAINT "user_vehicles_make_check" CHECK (length(btrim("user_vehicles"."make")) between 1 and 40),
	CONSTRAINT "user_vehicles_model_check" CHECK (length(btrim("user_vehicles"."model")) between 1 and 60),
	CONSTRAINT "user_vehicles_engine_check" CHECK ("user_vehicles"."engine" is null or length(btrim("user_vehicles"."engine")) between 1 and 40),
	CONSTRAINT "user_vehicles_year_check" CHECK ("user_vehicles"."year" is null or "user_vehicles"."year" between 1950 and 2100),
	CONSTRAINT "user_vehicles_mileage_km_check" CHECK ("user_vehicles"."mileage_km" is null or "user_vehicles"."mileage_km" between 0 and 2000000),
	CONSTRAINT "user_vehicles_mileage_at_check" CHECK (("user_vehicles"."mileage_km" is null) = ("user_vehicles"."mileage_at" is null))
);
--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "kit_id" uuid;--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "repeat_order_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "user_vehicles" ADD CONSTRAINT "user_vehicles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_vehicles_user_id_idx" ON "user_vehicles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_vehicles_user_id_vin_unique" ON "user_vehicles" USING btree ("user_id","vin") WHERE "user_vehicles"."vin" is not null;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_kit_id_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_repeat_order_id_orders_id_fk" FOREIGN KEY ("repeat_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_vehicle_id_user_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."user_vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "carts_kit_id_idx" ON "carts" USING btree ("kit_id") WHERE "carts"."kit_id" is not null;--> statement-breakpoint
CREATE INDEX "carts_repeat_order_id_idx" ON "carts" USING btree ("repeat_order_id") WHERE "carts"."repeat_order_id" is not null;--> statement-breakpoint
CREATE INDEX "orders_vehicle_id_idx" ON "orders" USING btree ("vehicle_id") WHERE "orders"."vehicle_id" is not null;--> statement-breakpoint
-- Step 6 (docs/garage.md): the cars follow their client. An anonymized client (users.anonymized_at
-- set, the phone replaced with anon:<id>) has no cars: they are deleted here, and orders.vehicle_id
-- of the orders is cleared by its foreign key (on delete set null). Whatever anonymizes the user,
-- the documented UPDATE of users or an admin command later, the cars go with it; a deleted user
-- takes them through the cascade of user_vehicles.user_id.
CREATE FUNCTION "user_vehicles_forget_anonymized"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "user_vehicles" WHERE "user_id" = NEW."id";
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "users_anonymized_forget_vehicles" AFTER UPDATE OF "anonymized_at", "phone" ON "users"
  FOR EACH ROW WHEN (NEW."anonymized_at" IS NOT NULL OR NEW."phone" LIKE 'anon:%')
  EXECUTE FUNCTION "user_vehicles_forget_anonymized"();
