-- Hand-written: the data export includes the user's own audit events (R-PRIV-05, R-LOG-03: "shown nowhere but the
-- export") and counts their export_requested events for its rolling limit of 2 per 24 hours (D-09). The app role may
-- read only the rows of the user in context (RLS); it still cannot change or delete any.
-- docs/data-model.md §4; enforced by test/security/db-roles.test.ts and test/security/rls-coverage.test.ts.
GRANT SELECT ON TABLE "audit_events" TO questline_app;
--> statement-breakpoint
CREATE POLICY "audit_events_app_select" ON "audit_events" FOR SELECT TO questline_app
  USING ("user_id" = app_current_user_id());