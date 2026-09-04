DROP INDEX "attributions_result_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "attributions_result_idx" ON "attributions" USING btree ("result_id");