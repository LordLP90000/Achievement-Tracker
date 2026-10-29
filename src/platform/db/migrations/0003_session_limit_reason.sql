-- Q-29: a login that would open a 21st live session revokes the least recently used one with this reason.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_revoked_reason_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_reason_check" CHECK ("sessions"."revoked_reason" in ('logout', 'logout_all', 'user_revoked', 'password_changed', 'password_reset',
        'refresh_reuse', 'expired', 'account_deleted', 'session_limit'));