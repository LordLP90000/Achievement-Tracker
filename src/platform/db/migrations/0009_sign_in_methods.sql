CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" "bytea" NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" bigint NOT NULL,
	"transports" text[] NOT NULL,
	"backed_up" boolean NOT NULL,
	"name_enc" "bytea",
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "passkeys_credential_id_check" CHECK (octet_length("passkeys"."credential_id") between 1 and 1023),
	CONSTRAINT "passkeys_public_key_check" CHECK (octet_length("passkeys"."public_key") between 1 and 2048),
	CONSTRAINT "passkeys_sign_count_check" CHECK ("passkeys"."sign_count" between 0 and 4294967295),
	CONSTRAINT "passkeys_transports_check" CHECK ("passkeys"."transports" <@ array['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]
        and cardinality("passkeys"."transports") <= 7)
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recovery_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "recovery_codes_code_hash_check" CHECK (octet_length("recovery_codes"."code_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "second_factor_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "second_factor_challenges_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "second_factor_challenges_token_hash_check" CHECK (octet_length("second_factor_challenges"."token_hash") = 32),
	CONSTRAINT "second_factor_challenges_failed_attempts_check" CHECK ("second_factor_challenges"."failed_attempts" between 0 and 5),
	CONSTRAINT "second_factor_challenges_lifetime_check" CHECK ("second_factor_challenges"."expires_at" > "second_factor_challenges"."created_at" and "second_factor_challenges"."expires_at" <= "second_factor_challenges"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "totp_secrets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_used_step" bigint,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "totp_secrets_enabled_check" CHECK ("totp_secrets"."enabled_at" >= "totp_secrets"."created_at"),
	CONSTRAINT "totp_secrets_last_used_step_check" CHECK ("totp_secrets"."last_used_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge_hash" "bytea" NOT NULL,
	"purpose" text NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "webauthn_challenges_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "webauthn_challenges_purpose_check" CHECK ("webauthn_challenges"."purpose" in ('registration', 'authentication')),
	CONSTRAINT "webauthn_challenges_user_check" CHECK (("webauthn_challenges"."purpose" = 'registration') = ("webauthn_challenges"."user_id" is not null)),
	CONSTRAINT "webauthn_challenges_challenge_hash_check" CHECK (octet_length("webauthn_challenges"."challenge_hash") = 32),
	CONSTRAINT "webauthn_challenges_lifetime_check" CHECK ("webauthn_challenges"."expires_at" > "webauthn_challenges"."created_at" and "webauthn_challenges"."expires_at" <= "webauthn_challenges"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_event_type_check";--> statement-breakpoint
ALTER TABLE "email_outbox" DROP CONSTRAINT "email_outbox_template_check";--> statement-breakpoint
-- Hand-edited: every existing session signed in with a password. The default fills them in and is dropped at once,
-- so from now on every insert must name how the session signed in (ADR-0019).
ALTER TABLE "sessions" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "auth_method" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "second_factor_challenges" ADD CONSTRAINT "second_factor_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD CONSTRAINT "totp_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkeys_user_id_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "second_factor_challenges_expires_idx" ON "second_factor_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "second_factor_challenges_user_id_idx" ON "second_factor_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "totp_secrets_pending_idx" ON "totp_secrets" USING btree ("created_at") WHERE "totp_secrets"."enabled_at" is null;--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_idx" ON "webauthn_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_user_id_idx" ON "webauthn_challenges" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_auth_method_check" CHECK ("sessions"."auth_method" in ('password', 'password_totp', 'password_recovery_code', 'passkey'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_event_type_check" CHECK ("audit_events"."event_type" in ('login_succeeded', 'login_failed', 'logout', 'session_revoked',
        'refresh_reuse_detected', 'password_changed', 'password_reset_requested', 'password_reset_completed',
        'email_change_requested', 'email_changed', 'email_verified', 'consent_granted', 'consent_withdrawn',
        'export_requested', 'account_deleted', 'account_reactivated', 'reauth_succeeded', 'reauth_failed',
        'rate_limited', 'passkey_added', 'passkey_removed', 'passkey_clone_suspected', 'totp_enabled', 'totp_disabled',
        'recovery_codes_generated', 'recovery_code_used', 'second_factor_failed'));--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_template_check" CHECK ("email_outbox"."template" in ('verify_email', 'registration_notice', 'password_reset', 'password_changed_notice',
        'email_change_verify', 'email_change_notice', 'account_deleted_notice', 'sign_in_methods_changed_notice'));
--> statement-breakpoint
-- Hand-written below (drizzle-kit does not track these): row-level security and least-privilege grants (ADR-0019).
-- docs/data-model.md §3.1 and §4; enforced by test/security/{db-roles,rls-coverage}.test.ts.
ALTER TABLE "passkeys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "passkeys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A passkey sign-in binds the account its authenticator names (the user handle) before it looks up the credential.
CREATE POLICY "passkeys_app" ON "passkeys" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "passkeys" TO questline_app;
--> statement-breakpoint
ALTER TABLE "totp_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "totp_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "totp_secrets_app" ON "totp_secrets" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
-- The hourly purge deletes secrets not confirmed within 24 hours (Q-53). It cannot see a confirmed one, let alone
-- delete it: no job can turn off anyone's second factor.
CREATE POLICY "totp_secrets_worker" ON "totp_secrets" TO questline_worker USING ("enabled_at" IS NULL);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "totp_secrets" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "totp_secrets" TO questline_worker;
--> statement-breakpoint
ALTER TABLE "recovery_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "recovery_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "recovery_codes_app" ON "recovery_codes" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
-- No UPDATE: a used code is deleted, and new codes replace the old ones by deleting them.
GRANT SELECT, INSERT, DELETE ON TABLE "recovery_codes" TO questline_app;
--> statement-breakpoint
-- The two challenge tables are exempt from row-level security: a response finds its row by the hash of the
-- challenge or token before the user is known, and a sign-in challenge belongs to no user. Used rows are deleted at
-- once, expired ones by the hourly purge.
GRANT SELECT, INSERT, DELETE ON TABLE "webauthn_challenges" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "webauthn_challenges" TO questline_worker;
--> statement-breakpoint
-- UPDATE: each wrong code counts against the token, which takes at most 5.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "second_factor_challenges" TO questline_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "second_factor_challenges" TO questline_worker;