ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_event_type_check";--> statement-breakpoint
ALTER TABLE "email_outbox" DROP CONSTRAINT "email_outbox_template_check";--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_event_type_check" CHECK ("audit_events"."event_type" in ('login_succeeded', 'login_failed', 'logout', 'session_revoked',
        'refresh_reuse_detected', 'password_changed', 'password_reset_requested', 'password_reset_completed',
        'email_change_requested', 'email_changed', 'email_verified', 'consent_granted', 'consent_withdrawn',
        'export_requested', 'account_deleted', 'account_reactivated', 'reauth_succeeded', 'reauth_failed',
        'rate_limited', 'passkey_added', 'passkey_removed', 'passkey_clone_suspected', 'totp_enabled', 'totp_disabled',
        'recovery_codes_generated', 'recovery_code_used', 'second_factor_failed', 'incident_notified'));--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_template_check" CHECK ("email_outbox"."template" in ('verify_email', 'registration_notice', 'password_reset', 'password_changed_notice',
        'email_change_verify', 'email_change_notice', 'account_deleted_notice', 'sign_in_methods_changed_notice',
        'incident_notice'));--> statement-breakpoint
-- Hand-written (ADR-0021, Q-61): the incident notice queues one email per account and records each in an audit event,
-- with the migrator's role, like the other maintenance commands (migration 0010). Both tables force row-level
-- security against their owner, so the migrator needs a policy on each. As the owner it could lift row-level security
-- anyway, so these policies cross no boundary; they keep its access explicit and listed. Enforced by
-- test/security/{db-roles,rls-coverage}.test.ts; docs/data-model.md §4.
CREATE POLICY "audit_events_maintenance" ON "audit_events" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "email_outbox_maintenance" ON "email_outbox" TO questline_migrator USING (true) WITH CHECK (true);