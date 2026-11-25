DROP INDEX "sessions_user_id_idx";--> statement-breakpoint
DROP INDEX "badges_user_id_idx";--> statement-breakpoint
DROP INDEX "gambles_achievement_idx";--> statement-breakpoint
CREATE INDEX "consents_user_granted_idx" ON "consents" USING btree ("user_id","granted_at","id");--> statement-breakpoint
CREATE INDEX "sessions_user_created_idx" ON "sessions" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "achievements_user_created_idx" ON "achievements" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "badges_user_awarded_idx" ON "badges" USING btree ("user_id","awarded_at","id");--> statement-breakpoint
CREATE INDEX "gambles_achievement_placed_idx" ON "gambles" USING btree ("achievement_id","placed_at","id");--> statement-breakpoint
CREATE INDEX "xp_events_user_created_idx" ON "xp_events" USING btree ("user_id","created_at","id");