CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "consents_type_check" CHECK ("consents"."type" in ('goal_content')),
	CONSTRAINT "consents_withdrawn_check" CHECK ("consents"."withdrawn_at" is null or "consents"."withdrawn_at" >= "consents"."granted_at")
);
--> statement-breakpoint
CREATE TABLE "one_time_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"new_email_enc" "bytea",
	"new_email_blind_index" "bytea",
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "one_time_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "one_time_tokens_purpose_check" CHECK ("one_time_tokens"."purpose" in ('verify_email', 'change_email', 'reset_password')),
	CONSTRAINT "one_time_tokens_new_email_check" CHECK (("one_time_tokens"."purpose" = 'change_email' and "one_time_tokens"."new_email_enc" is not null and "one_time_tokens"."new_email_blind_index" is not null)
        or ("one_time_tokens"."purpose" <> 'change_email' and "one_time_tokens"."new_email_enc" is null and "one_time_tokens"."new_email_blind_index" is null)),
	CONSTRAINT "one_time_tokens_lifetime_check" CHECK ("one_time_tokens"."expires_at" > "one_time_tokens"."created_at" and "one_time_tokens"."expires_at" <= "one_time_tokens"."created_at" + interval '30 minutes'),
	CONSTRAINT "one_time_tokens_token_hash_check" CHECK (octet_length("one_time_tokens"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "session_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"access_token_hash" "bytea" NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_hash" "bytea" NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_tokens_access_token_hash_unique" UNIQUE("access_token_hash"),
	CONSTRAINT "session_tokens_refresh_token_hash_unique" UNIQUE("refresh_token_hash"),
	CONSTRAINT "session_tokens_session_generation_unique" UNIQUE("session_id","generation"),
	CONSTRAINT "session_tokens_generation_check" CHECK ("session_tokens"."generation" >= 1),
	CONSTRAINT "session_tokens_hashes_check" CHECK (octet_length("session_tokens"."access_token_hash") = 32 and octet_length("session_tokens"."refresh_token_hash") = 32),
	CONSTRAINT "session_tokens_access_lifetime_check" CHECK ("session_tokens"."access_expires_at" > "session_tokens"."created_at"
        and "session_tokens"."access_expires_at" <= "session_tokens"."created_at" + interval '15 minutes'),
	CONSTRAINT "session_tokens_refresh_lifetime_check" CHECK ("session_tokens"."refresh_expires_at" > "session_tokens"."created_at"
        and "session_tokens"."refresh_expires_at" <= "session_tokens"."created_at" + interval '30 days')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client" text NOT NULL,
	"device_label_enc" "bytea",
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"last_reauth_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "sessions_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "sessions_client_check" CHECK ("sessions"."client" in ('ios', 'android')),
	CONSTRAINT "sessions_revoked_reason_check" CHECK ("sessions"."revoked_reason" in ('logout', 'logout_all', 'user_revoked', 'password_changed', 'password_reset',
        'refresh_reuse', 'expired', 'account_deleted')),
	CONSTRAINT "sessions_revoked_check" CHECK (("sessions"."revoked_at" is null) = ("sessions"."revoked_reason" is null)),
	CONSTRAINT "sessions_lifetime_check" CHECK ("sessions"."absolute_expires_at" > "sessions"."created_at"
        and "sessions"."absolute_expires_at" <= "sessions"."created_at" + interval '180 days')
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_id" text NOT NULL,
	"kek_version" integer NOT NULL,
	"dek_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "user_keys_versions_check" CHECK ("user_keys"."kek_version" >= 1 and "user_keys"."dek_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email_enc" "bytea" NOT NULL,
	"email_blind_index" "bytea" NOT NULL,
	"password_hash" text NOT NULL,
	"nickname_enc" "bytea",
	"timezone" text NOT NULL,
	"locale" text NOT NULL,
	"week_start" text DEFAULT 'monday' NOT NULL,
	"age_confirmed" boolean NOT NULL,
	"email_verified_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"privacy_policy_version" text NOT NULL,
	"password_changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_email_blind_index_unique" UNIQUE("email_blind_index"),
	CONSTRAINT "users_email_blind_index_check" CHECK (octet_length("users"."email_blind_index") = 32),
	CONSTRAINT "users_week_start_check" CHECK ("users"."week_start" in ('monday', 'sunday', 'saturday')),
	CONSTRAINT "users_age_confirmed_check" CHECK ("users"."age_confirmed"),
	CONSTRAINT "users_version_check" CHECK ("users"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"event_type" text NOT NULL,
	"session_id" uuid,
	"ip_prefix" "cidr",
	"client" text,
	"outcome" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_events_event_type_check" CHECK ("audit_events"."event_type" in ('login_succeeded', 'login_failed', 'logout', 'session_revoked',
        'refresh_reuse_detected', 'password_changed', 'password_reset_requested', 'password_reset_completed',
        'email_change_requested', 'email_changed', 'email_verified', 'consent_granted', 'consent_withdrawn',
        'export_requested', 'account_deleted', 'account_reactivated', 'reauth_succeeded', 'reauth_failed',
        'rate_limited')),
	CONSTRAINT "audit_events_ip_prefix_check" CHECK (masklen("audit_events"."ip_prefix") <= case family("audit_events"."ip_prefix") when 4 then 24 else 48 end),
	CONSTRAINT "audit_events_client_check" CHECK ("audit_events"."client" in ('ios', 'android')),
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" in ('success', 'failure')),
	CONSTRAINT "audit_events_metadata_check" CHECK (jsonb_typeof("audit_events"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "deleted_user_tombstones" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"template" text NOT NULL,
	"payload_enc" "bytea" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error_code" text,
	"sent_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_outbox_template_check" CHECK ("email_outbox"."template" in ('verify_email', 'registration_notice', 'password_reset', 'password_changed_notice',
        'email_change_verify', 'email_change_notice', 'account_deleted_notice')),
	CONSTRAINT "email_outbox_attempts_check" CHECK ("email_outbox"."attempts" >= 0),
	CONSTRAINT "email_outbox_last_error_code_check" CHECK ("email_outbox"."last_error_code" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "email_outbox_state_check" CHECK ("email_outbox"."sent_at" is null or "email_outbox"."dead_at" is null)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"bucket_key" "bytea" PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_buckets_bucket_key_check" CHECK (octet_length("rate_limit_buckets"."bucket_key") = 32),
	CONSTRAINT "rate_limit_buckets_counters_check" CHECK ("rate_limit_buckets"."tokens" >= 0 and "rate_limit_buckets"."failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tokens" ADD CONSTRAINT "session_tokens_session_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consents_active_unique" ON "consents" USING btree ("user_id","type") WHERE "consents"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "one_time_tokens_user_purpose_idx" ON "one_time_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_events_user_created_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("next_attempt_at") WHERE "email_outbox"."sent_at" is null and "email_outbox"."dead_at" is null;--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_updated_idx" ON "rate_limit_buckets" USING btree ("updated_at");--> statement-breakpoint
-- Hand-written below (drizzle-kit does not track these): storage, row-level security and least-privilege grants.
-- docs/data-model.md §4; enforced by test/security/{db-roles,rls-coverage}.test.ts and test/integration/account-schema.test.ts.
-- Rate-limit buckets are disposable counters: not written to the WAL, emptied after a crash.
ALTER TABLE "rate_limit_buckets" SET UNLOGGED;
--> statement-breakpoint
ALTER TABLE "user_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_keys_app" ON "user_keys" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "user_keys_worker" ON "user_keys" TO questline_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sessions_app" ON "sessions" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "sessions_worker" ON "sessions" TO questline_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "consents_app" ON "consents" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The API only appends audit events: for its own user, or without a user for unknown accounts (failed logins).
CREATE POLICY "audit_events_app_insert" ON "audit_events" FOR INSERT TO questline_app
  WITH CHECK ("user_id" IS NULL OR "user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "audit_events_worker" ON "audit_events" TO questline_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "email_outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "email_outbox_app_insert" ON "email_outbox" FOR INSERT TO questline_app
  WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "email_outbox_worker" ON "email_outbox" TO questline_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "users" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "users" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "user_keys" TO questline_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "user_keys" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "one_time_tokens" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "one_time_tokens" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "sessions" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "sessions" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "session_tokens" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "session_tokens" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "consents" TO questline_app;
--> statement-breakpoint
GRANT INSERT ON TABLE "audit_events" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "audit_events" TO questline_worker;
--> statement-breakpoint
GRANT INSERT ON TABLE "email_outbox" TO questline_app;
--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON TABLE "email_outbox" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "rate_limit_buckets" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "rate_limit_buckets" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "deleted_user_tombstones" TO questline_worker;
