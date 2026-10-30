-- Hand-written: withdrawing the goal-content consent deletes all goal content at once (Q-10, R-PRIV-04),
-- including the stored responses of create requests, which hold encrypted goal content for up to 24 hours (ADR-0008).
-- docs/data-model.md §4; enforced by test/security/db-roles.test.ts and test/integration/consents.test.ts.
GRANT DELETE ON TABLE "idempotency_keys" TO questline_app;