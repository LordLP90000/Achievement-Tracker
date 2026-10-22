-- Platform baseline (ADR-0003, docs/data-model.md §4), run by questline_migrator, owner of schema public.
-- Application roles get USAGE only: they can use objects they are granted, but never create any.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO questline_app, questline_worker;
--> statement-breakpoint
-- Row-level-security helper used by every user-data policy. NULL when the transaction has no user context
-- (unset or reset to ''), so "user_id = app_current_user_id()" matches no row: a forgotten context fails closed.
-- A malformed value raises an error instead of matching anything. search_path is pinned against hijacking.
CREATE FUNCTION public.app_current_user_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_current_user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO questline_app, questline_worker;
