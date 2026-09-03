ALTER TABLE "attributions" DROP CONSTRAINT "attributions_result_id_question_results_id_fk";
--> statement-breakpoint
ALTER TABLE "chunk_embeddings" DROP CONSTRAINT "chunk_embeddings_chunk_id_chunks_id_fk";
--> statement-breakpoint
ALTER TABLE "chunk_sets" DROP CONSTRAINT "chunk_sets_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "chunks" DROP CONSTRAINT "chunks_chunk_set_id_chunk_sets_id_fk";
--> statement-breakpoint
ALTER TABLE "chunks" DROP CONSTRAINT "chunks_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "eval_run_configs" DROP CONSTRAINT "eval_run_configs_run_id_eval_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "eval_run_configs" DROP CONSTRAINT "eval_run_configs_config_id_rag_configs_id_fk";
--> statement-breakpoint
ALTER TABLE "eval_runs" DROP CONSTRAINT "eval_runs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "eval_runs" DROP CONSTRAINT "eval_runs_test_set_id_test_sets_id_fk";
--> statement-breakpoint
ALTER TABLE "question_results" DROP CONSTRAINT "question_results_run_id_eval_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "question_results" DROP CONSTRAINT "question_results_config_id_rag_configs_id_fk";
--> statement-breakpoint
ALTER TABLE "question_results" DROP CONSTRAINT "question_results_question_id_test_questions_id_fk";
--> statement-breakpoint
ALTER TABLE "rag_configs" DROP CONSTRAINT "rag_configs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "rag_configs" DROP CONSTRAINT "rag_configs_chunk_set_id_chunk_sets_id_fk";
--> statement-breakpoint
ALTER TABLE "test_questions" DROP CONSTRAINT "test_questions_test_set_id_test_sets_id_fk";
--> statement-breakpoint
ALTER TABLE "test_questions" DROP CONSTRAINT "test_questions_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "test_sets" DROP CONSTRAINT "test_sets_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_result_id_question_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."question_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_sets" ADD CONSTRAINT "chunk_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_chunk_set_id_chunk_sets_id_fk" FOREIGN KEY ("chunk_set_id") REFERENCES "public"."chunk_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_configs" ADD CONSTRAINT "eval_run_configs_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_configs" ADD CONSTRAINT "eval_run_configs_config_id_rag_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."rag_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_test_set_id_test_sets_id_fk" FOREIGN KEY ("test_set_id") REFERENCES "public"."test_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_results" ADD CONSTRAINT "question_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_results" ADD CONSTRAINT "question_results_config_id_rag_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."rag_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_results" ADD CONSTRAINT "question_results_question_id_test_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."test_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_configs" ADD CONSTRAINT "rag_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_configs" ADD CONSTRAINT "rag_configs_chunk_set_id_chunk_sets_id_fk" FOREIGN KEY ("chunk_set_id") REFERENCES "public"."chunk_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_questions" ADD CONSTRAINT "test_questions_test_set_id_test_sets_id_fk" FOREIGN KEY ("test_set_id") REFERENCES "public"."test_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_questions" ADD CONSTRAINT "test_questions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_sets" ADD CONSTRAINT "test_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_embeddings_chunk_idx" ON "chunk_embeddings" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "chunk_sets_project_idx" ON "chunk_sets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "chunks_set_idx" ON "chunks" USING btree ("chunk_set_id");--> statement-breakpoint
CREATE INDEX "chunks_doc_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "question_results_run_idx" ON "question_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "test_questions_set_idx" ON "test_questions" USING btree ("test_set_id");--> statement-breakpoint
CREATE INDEX "usage_log_org_idx" ON "usage_log" USING btree ("organization_id");