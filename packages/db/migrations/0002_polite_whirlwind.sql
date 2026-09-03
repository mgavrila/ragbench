ALTER TABLE "chunk_sets" ADD COLUMN "docs_fingerprint" text;--> statement-breakpoint
ALTER TABLE "test_sets" ADD COLUMN "status" text DEFAULT 'generating' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_sets" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "test_sets" ADD COLUMN "questions_target" integer DEFAULT 30 NOT NULL;