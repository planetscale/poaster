DROP INDEX "idx_activity_user_id";--> statement-breakpoint
CREATE INDEX "idx_activity_on_target_type_target_id_created_at" ON "activity" USING btree ("target_type","target_id","created_at");