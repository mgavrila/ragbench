ALTER TABLE "chunk_sets" ADD COLUMN "embed_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk_sets" ADD COLUMN "embed_error" text;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "answer_model" text;--> statement-breakpoint
CREATE INDEX "attributions_result_idx" ON "attributions" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "eval_runs_project_idx" ON "eval_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "eval_runs_test_set_idx" ON "eval_runs" USING btree ("test_set_id");--> statement-breakpoint
CREATE INDEX "question_results_config_idx" ON "question_results" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "question_results_question_idx" ON "question_results" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "rag_configs_project_idx" ON "rag_configs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "rag_configs_chunk_set_idx" ON "rag_configs" USING btree ("chunk_set_id");