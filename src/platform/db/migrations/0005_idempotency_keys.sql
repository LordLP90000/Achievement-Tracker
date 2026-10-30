CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"route" text NOT NULL,
	"key" uuid NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"response_status" integer NOT NULL,
	"response_body_enc" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_user_route_key_unique" UNIQUE("user_id","route","key"),
	CONSTRAINT "idempotency_keys_route_check" CHECK ("idempotency_keys"."route" in ('createAchievement', 'createQuest', 'placeGamble', 'createCheckIn')),
	CONSTRAINT "idempotency_keys_request_hash_check" CHECK (octet_length("idempotency_keys"."request_hash") = 32),
	CONSTRAINT "idempotency_keys_response_status_check" CHECK ("idempotency_keys"."response_status" between 200 and 299),
	CONSTRAINT "idempotency_keys_lifetime_check" CHECK ("idempotency_keys"."expires_at" > "idempotency_keys"."created_at" and "idempotency_keys"."expires_at" <= "idempotency_keys"."created_at" + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");
--> statement-breakpoint
-- Hand-written below (drizzle-kit does not track these): row-level security and least-privilege grants.
-- docs/data-model.md §3.5 and §4; enforced by test/security/{db-roles,rls-coverage}.test.ts.
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "idempotency_keys_app" ON "idempotency_keys" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
-- The hourly purge job deletes records whose 24 hours are over (ADR-0008).
CREATE POLICY "idempotency_keys_worker" ON "idempotency_keys" TO questline_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
-- UPDATE: a request with a key whose record expired replaces that record (ADR-0008).
GRANT SELECT, INSERT, UPDATE ON TABLE "idempotency_keys" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "idempotency_keys" TO questline_worker;
