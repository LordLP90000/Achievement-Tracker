CREATE TABLE "goal_evaluations" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"evaluated_on" date NOT NULL,
	"due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goal_evaluations" ADD CONSTRAINT "goal_evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_evaluations_due_idx" ON "goal_evaluations" USING btree ("due_at");
--> statement-breakpoint
-- Hand-written below (drizzle-kit does not track these): grants and policies for the daily goal evaluation in the
-- worker (A-20, A-21). It reads every user's goals to find who is due, then runs the goal engine for one user at a
-- time with that user's context set, so it can change only that user's rows, like the API.
-- docs/data-model.md §4; enforced by test/security/{db-roles,rls-coverage}.test.ts.
GRANT SELECT, INSERT, UPDATE ON TABLE "goal_evaluations" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "achievements" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "quests" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "gambles" TO questline_worker;
--> statement-breakpoint
GRANT SELECT ON TABLE "check_ins" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "xp_events" TO questline_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "badges" TO questline_worker;
--> statement-breakpoint
-- Who is due: active achievements with a habit or a pending gamble, across users.
CREATE POLICY "achievements_worker_read" ON "achievements" FOR SELECT TO questline_worker USING (true);
--> statement-breakpoint
CREATE POLICY "quests_worker_read" ON "quests" FOR SELECT TO questline_worker USING (true);
--> statement-breakpoint
CREATE POLICY "gambles_worker_read" ON "gambles" FOR SELECT TO questline_worker USING (true);
--> statement-breakpoint
-- Changes only for the user whose context the goal engine set.
CREATE POLICY "achievements_worker_update" ON "achievements" FOR UPDATE TO questline_worker
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "quests_worker_update" ON "quests" FOR UPDATE TO questline_worker
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "gambles_worker_update" ON "gambles" FOR UPDATE TO questline_worker
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "check_ins_worker" ON "check_ins" TO questline_worker USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "xp_events_worker" ON "xp_events" TO questline_worker USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
CREATE POLICY "badges_worker" ON "badges" TO questline_worker USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
