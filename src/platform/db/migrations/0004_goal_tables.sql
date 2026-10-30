CREATE TABLE "achievements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title_enc" "bytea" NOT NULL,
	"description_enc" "bytea",
	"motivation_enc" "bytea",
	"category_enc" "bytea",
	"target_date_enc" "bytea",
	"deadline_enc" "bytea",
	"status" text NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone,
	"execution_score" numeric(5, 2),
	"rank" text,
	"dek_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "achievements_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "achievements_status_check" CHECK ("achievements"."status" in ('active', 'paused', 'completed')),
	CONSTRAINT "achievements_rank_check" CHECK ("achievements"."rank" in ('unranked', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'champion')),
	CONSTRAINT "achievements_execution_score_check" CHECK ("achievements"."execution_score" between 0 and 100),
	CONSTRAINT "achievements_completion_check" CHECK (("achievements"."status" = 'completed') = ("achievements"."completed_at" is not null)
        and ("achievements"."completed_at" is null) = ("achievements"."execution_score" is null)
        and ("achievements"."completed_at" is null) = ("achievements"."rank" is null)),
	CONSTRAINT "achievements_counters_check" CHECK ("achievements"."attempt" >= 1 and "achievements"."dek_version" >= 1 and "achievements"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"achievement_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"rank" text NOT NULL,
	"awarded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "badges_achievement_kind_unique" UNIQUE("achievement_id","kind"),
	CONSTRAINT "badges_kind_check" CHECK ("badges"."kind" in ('achievement_rank')),
	CONSTRAINT "badges_rank_check" CHECK ("badges"."rank" in ('unranked', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'champion'))
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"quest_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"attempt" integer NOT NULL,
	"counts_for_progress" boolean NOT NULL,
	"value_enc" "bytea",
	"note_enc" "bytea",
	"dek_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "check_ins_counters_check" CHECK ("check_ins"."attempt" >= 1 and "check_ins"."dek_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "gambles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"achievement_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"stake" bigint NOT NULL,
	"status" text NOT NULL,
	"loss_reason" text,
	"placed_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "gambles_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "gambles_status_check" CHECK ("gambles"."status" in ('pending', 'won', 'lost')),
	CONSTRAINT "gambles_loss_reason_check" CHECK ("gambles"."loss_reason" in ('target_date_passed', 'habit_reset', 'paused', 'deleted')),
	CONSTRAINT "gambles_settlement_check" CHECK (("gambles"."status" = 'pending') = ("gambles"."settled_at" is null)
        and ("gambles"."status" = 'lost') = ("gambles"."loss_reason" is not null)
        and ("gambles"."settled_at" is null or "gambles"."settled_at" >= "gambles"."placed_at")),
	CONSTRAINT "gambles_counters_check" CHECK ("gambles"."stake" > 0 and "gambles"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "quests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"achievement_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"size" text NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"prerequisite_quest_id" uuid,
	"title_enc" "bytea" NOT NULL,
	"notes_enc" "bytea",
	"unit_enc" "bytea",
	"start_value_enc" "bytea",
	"target_value_enc" "bytea",
	"habit_period" text,
	"habit_times_per_period" integer,
	"habit_period_count" integer,
	"habit_start_date" date,
	"habit_week_start" text,
	"reset_count" integer DEFAULT 0 NOT NULL,
	"habit_best_streak" integer DEFAULT 0 NOT NULL,
	"needs_restart" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"dek_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "quests_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "quests_id_achievement_id_unique" UNIQUE("id","achievement_id"),
	CONSTRAINT "quests_type_check" CHECK ("quests"."type" in ('one_time', 'habit', 'target')),
	CONSTRAINT "quests_size_check" CHECK ("quests"."size" in ('S', 'M', 'L')),
	CONSTRAINT "quests_prerequisite_check" CHECK ("quests"."prerequisite_quest_id" <> "quests"."id"),
	CONSTRAINT "quests_habit_period_check" CHECK ("quests"."habit_period" in ('day', 'week')),
	CONSTRAINT "quests_habit_times_per_period_check" CHECK ("quests"."habit_times_per_period" between 1 and 50),
	CONSTRAINT "quests_habit_period_count_check" CHECK ("quests"."habit_period_count" between 1 and 520),
	CONSTRAINT "quests_habit_week_start_check" CHECK ("quests"."habit_week_start" in ('monday', 'sunday', 'saturday')),
	CONSTRAINT "quests_habit_columns_check" CHECK (("quests"."type" = 'habit') = ("quests"."habit_period" is not null)
        and ("quests"."type" = 'habit') = ("quests"."habit_times_per_period" is not null)
        and ("quests"."type" = 'habit') = ("quests"."habit_period_count" is not null)
        and ("quests"."type" = 'habit') = ("quests"."habit_start_date" is not null)
        and ("quests"."habit_period" is not distinct from 'week') = ("quests"."habit_week_start" is not null)),
	CONSTRAINT "quests_target_columns_check" CHECK (("quests"."type" = 'target') = ("quests"."start_value_enc" is not null)
        and ("quests"."type" = 'target') = ("quests"."target_value_enc" is not null)
        and ("quests"."type" = 'target' or "quests"."unit_enc" is null)),
	CONSTRAINT "quests_habit_state_check" CHECK (("quests"."type" = 'habit' or ("quests"."reset_count" = 0 and "quests"."habit_best_streak" = 0 and not "quests"."needs_restart"))
        and not ("quests"."needs_restart" and "quests"."completed_at" is not null)),
	CONSTRAINT "quests_counters_check" CHECK ("quests"."position" >= 0 and "quests"."reset_count" >= 0 and "quests"."habit_best_streak" >= 0
        and "quests"."dek_version" >= 1 and "quests"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "xp_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"quest_id" uuid,
	"achievement_id" uuid,
	"gamble_id" uuid,
	"local_date" date NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "xp_events_kind_check" CHECK ("xp_events"."kind" in ('quest_completed', 'rank_bonus', 'gamble_won', 'xp_floor', 'quest_uncompleted', 'rank_bonus_revoked', 'gamble_lost', 'gamble_reverted', 'pause_revoked', 'quest_deleted',
        'achievement_deleted')),
	CONSTRAINT "xp_events_amount_check" CHECK (case when "xp_events"."kind" in ('quest_completed', 'rank_bonus', 'gamble_won', 'xp_floor') then "xp_events"."amount" > 0 else "xp_events"."amount" < 0 end)
);
--> statement-breakpoint
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badges" ADD CONSTRAINT "badges_achievement_fk" FOREIGN KEY ("achievement_id","user_id") REFERENCES "public"."achievements"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_quest_fk" FOREIGN KEY ("quest_id","user_id") REFERENCES "public"."quests"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gambles" ADD CONSTRAINT "gambles_achievement_fk" FOREIGN KEY ("achievement_id","user_id") REFERENCES "public"."achievements"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quests" ADD CONSTRAINT "quests_achievement_fk" FOREIGN KEY ("achievement_id","user_id") REFERENCES "public"."achievements"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quests" ADD CONSTRAINT "quests_prerequisite_fk" FOREIGN KEY ("prerequisite_quest_id","achievement_id") REFERENCES "public"."quests"("id","achievement_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_quest_fk" FOREIGN KEY ("quest_id","user_id") REFERENCES "public"."quests"("id","user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_achievement_fk" FOREIGN KEY ("achievement_id","user_id") REFERENCES "public"."achievements"("id","user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_gamble_fk" FOREIGN KEY ("gamble_id","user_id") REFERENCES "public"."gambles"("id","user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "achievements_user_status_created_idx" ON "achievements" USING btree ("user_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "badges_user_id_idx" ON "badges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "check_ins_counting_idx" ON "check_ins" USING btree ("quest_id","attempt","local_date") WHERE "check_ins"."counts_for_progress";--> statement-breakpoint
CREATE INDEX "check_ins_quest_created_idx" ON "check_ins" USING btree ("quest_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "gambles_pending_unique" ON "gambles" USING btree ("user_id") WHERE "gambles"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "gambles_achievement_idx" ON "gambles" USING btree ("achievement_id");--> statement-breakpoint
CREATE INDEX "quests_achievement_position_idx" ON "quests" USING btree ("achievement_id","position");--> statement-breakpoint
CREATE INDEX "quests_user_id_idx" ON "quests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "xp_events_user_date_idx" ON "xp_events" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "xp_events_quest_idx" ON "xp_events" USING btree ("quest_id") WHERE "xp_events"."quest_id" is not null;--> statement-breakpoint
CREATE INDEX "xp_events_achievement_idx" ON "xp_events" USING btree ("achievement_id") WHERE "xp_events"."achievement_id" is not null;--> statement-breakpoint
CREATE INDEX "xp_events_gamble_idx" ON "xp_events" USING btree ("gamble_id") WHERE "xp_events"."gamble_id" is not null;--> statement-breakpoint
-- Hand-written below (drizzle-kit does not track these): single-column ON DELETE SET NULL, row-level security and
-- least-privilege grants. docs/data-model.md §3.3–3.4 and §4; enforced by test/security/{db-roles,rls-coverage}.test.ts
-- and test/integration/goal-schema.test.ts.
-- Deleting a prerequisite, quest, achievement or gamble clears only the reference: the rest of the composite key
-- (achievement_id, user_id) stays (PostgreSQL 15+ column list; drizzle-kit can only null every column).
ALTER TABLE "quests" DROP CONSTRAINT "quests_prerequisite_fk";
--> statement-breakpoint
ALTER TABLE "quests" ADD CONSTRAINT "quests_prerequisite_fk" FOREIGN KEY ("prerequisite_quest_id","achievement_id")
  REFERENCES "public"."quests"("id","achievement_id") ON DELETE SET NULL ("prerequisite_quest_id");
--> statement-breakpoint
ALTER TABLE "xp_events" DROP CONSTRAINT "xp_events_quest_fk";
--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_quest_fk" FOREIGN KEY ("quest_id","user_id")
  REFERENCES "public"."quests"("id","user_id") ON DELETE SET NULL ("quest_id");
--> statement-breakpoint
ALTER TABLE "xp_events" DROP CONSTRAINT "xp_events_achievement_fk";
--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_achievement_fk" FOREIGN KEY ("achievement_id","user_id")
  REFERENCES "public"."achievements"("id","user_id") ON DELETE SET NULL ("achievement_id");
--> statement-breakpoint
ALTER TABLE "xp_events" DROP CONSTRAINT "xp_events_gamble_fk";
--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_gamble_fk" FOREIGN KEY ("gamble_id","user_id")
  REFERENCES "public"."gambles"("id","user_id") ON DELETE SET NULL ("gamble_id");
--> statement-breakpoint
ALTER TABLE "achievements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "achievements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "achievements_app" ON "achievements" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
ALTER TABLE "gambles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gambles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "gambles_app" ON "gambles" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
ALTER TABLE "quests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "quests_app" ON "quests" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
ALTER TABLE "check_ins" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "check_ins" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "check_ins_app" ON "check_ins" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
ALTER TABLE "xp_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "xp_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "xp_events_app" ON "xp_events" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
ALTER TABLE "badges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "badges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "badges_app" ON "badges" TO questline_app
  USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
--> statement-breakpoint
-- R-ACH-07: completed achievements are the user's archive; only withdrawing the goal-content consent removes them (Q-10).
CREATE POLICY "achievements_app_delete_guard" ON "achievements" AS RESTRICTIVE FOR DELETE TO questline_app
  USING ("status" <> 'completed' OR NOT EXISTS (SELECT 1 FROM "consents" WHERE "consents"."user_id" = app_current_user_id()
    AND "consents"."type" = 'goal_content' AND "consents"."withdrawn_at" IS NULL));
--> statement-breakpoint
-- R-XP-01: the ledger is append-only for the API (no UPDATE grant); only withdrawing the goal-content consent deletes
-- it (Q-10). Achievement, quest and gamble deletions keep their ledger rows and only unlink them.
CREATE POLICY "xp_events_app_delete_guard" ON "xp_events" AS RESTRICTIVE FOR DELETE TO questline_app
  USING (NOT EXISTS (SELECT 1 FROM "consents" WHERE "consents"."user_id" = app_current_user_id()
    AND "consents"."type" = 'goal_content' AND "consents"."withdrawn_at" IS NULL));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "achievements" TO questline_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "gambles" TO questline_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "quests" TO questline_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "check_ins" TO questline_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "xp_events" TO questline_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "badges" TO questline_app;
