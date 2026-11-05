-- Hand-written (ADR-0020, Q-56, Q-57): the maintenance commands run as questline_migrator, the owner of every table,
-- while the API and the worker are stopped. FORCE ROW LEVEL SECURITY applies to the owner as well, so the migrator
-- needs a policy on each table whose rows a command changes for every account: the KEK re-wrap (user_keys) and the
-- replay after a restore (the rest; the other goal-content tables follow achievements by cascade). As the owner it
-- could lift row-level security anyway, so these policies cross no boundary; they keep its access explicit and
-- listed. Enforced by test/security/{db-roles,rls-coverage}.test.ts; docs/data-model.md §4.
CREATE POLICY "achievements_maintenance" ON "achievements" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "consents_maintenance" ON "consents" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "idempotency_keys_maintenance" ON "idempotency_keys" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "passkeys_maintenance" ON "passkeys" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "recovery_codes_maintenance" ON "recovery_codes" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "sessions_maintenance" ON "sessions" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "totp_secrets_maintenance" ON "totp_secrets" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "user_keys_maintenance" ON "user_keys" TO questline_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "xp_events_maintenance" ON "xp_events" TO questline_migrator USING (true) WITH CHECK (true);
