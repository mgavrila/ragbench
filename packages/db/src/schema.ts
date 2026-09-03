import {
  pgTable, uuid, text, integer, doublePrecision, timestamp, jsonb, boolean,
  customType, uniqueIndex, index,
} from "drizzle-orm/pg-core";

// pgvector column, deliberately dimension-untyped (spec §3 judgment call 1)
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v) as number[],
});

const id = () => uuid("id").defaultRandom().primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// ---- tenancy ----
export const organizations = pgTable("organizations", {
  id: id(), name: text("name").notNull(), createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  organizationId: uuid("organization_id").references(() => organizations.id).notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const usageLog = pgTable("usage_log", {
  id: id(),
  organizationId: uuid("organization_id").references(() => organizations.id).notNull(),
  purpose: text("purpose").notNull(), // 'embed' | 'testset' | 'answer' | 'judge' | 'attribution'
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: doublePrecision("cost_usd").notNull(),
  createdAt: createdAt(),
}, (t) => [index("usage_log_org_idx").on(t.organizationId)]);

// ---- corpus ----
export const projects = pgTable("projects", {
  id: id(),
  organizationId: uuid("organization_id").references(() => organizations.id).notNull(),
  name: text("name").notNull(),
  createdAt: createdAt(),
}, (t) => [index("projects_org_idx").on(t.organizationId)]);

export const documents = pgTable("documents", {
  id: id(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  contentHash: text("content_hash").notNull(),
  text: text("text"),
  status: text("status").notNull().default("parsing"), // parsing | ready | failed
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("documents_project_idx").on(t.projectId)]);

export const chunkSets = pgTable("chunk_sets", {
  id: id(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  chunker: text("chunker").notNull(), // fixed | heading | sentence-window
  params: jsonb("params").notNull().$type<Record<string, unknown>>(),
  paramsHash: text("params_hash").notNull(),
  // sha256(paramsHash + ":" + sorted-joined contentHashes of the ready docs chunked last rebuild).
  // Null until the first rebuild. Lets chunkHandler skip a delete-and-recreate when nothing about
  // the params or the ready document set has changed since the last rebuild.
  docsFingerprint: text("docs_fingerprint"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("chunk_sets_uniq").on(t.projectId, t.chunker, t.paramsHash),
  index("chunk_sets_project_idx").on(t.projectId),
]);

export const chunks = pgTable("chunks", {
  id: id(),
  chunkSetId: uuid("chunk_set_id").references(() => chunkSets.id, { onDelete: "cascade" }).notNull(),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }).notNull(),
  idx: integer("idx").notNull(),
  text: text("text").notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
}, (t) => [
  index("chunks_set_idx").on(t.chunkSetId),
  index("chunks_doc_idx").on(t.documentId),
]);

export const chunkEmbeddings = pgTable("chunk_embeddings", {
  id: id(),
  chunkId: uuid("chunk_id").references(() => chunks.id, { onDelete: "cascade" }).notNull(),
  model: text("model").notNull(),
  dimension: integer("dimension").notNull(),
  embedding: vector("embedding").notNull(),
}, (t) => [
  uniqueIndex("chunk_embeddings_uniq").on(t.chunkId, t.model),
  index("chunk_embeddings_chunk_idx").on(t.chunkId),
]);

// ---- eval ----
export const ragConfigs = pgTable("rag_configs", {
  id: id(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  chunkSetId: uuid("chunk_set_id").references(() => chunkSets.id, { onDelete: "cascade" }).notNull(),
  embeddingModel: text("embedding_model").notNull(),
  topK: integer("top_k").notNull(),
  createdAt: createdAt(),
});

export const testSets = pgTable("test_sets", {
  id: id(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  generatorModel: text("generator_model").notNull(),
  status: text("status").notNull().default("generating"), // generating | ready | failed
  error: text("error"),
  questionsTarget: integer("questions_target").notNull().default(30),
  createdAt: createdAt(),
});

export const testQuestions = pgTable("test_questions", {
  id: id(),
  testSetId: uuid("test_set_id").references(() => testSets.id, { onDelete: "cascade" }).notNull(),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }).notNull(),
  question: text("question").notNull(),
  goldAnswer: text("gold_answer").notNull(),
  goldStart: integer("gold_start").notNull(),
  goldEnd: integer("gold_end").notNull(),
  status: text("status").notNull().default("active"), // active | deleted
}, (t) => [index("test_questions_set_idx").on(t.testSetId)]);

export const evalRuns = pgTable("eval_runs", {
  id: id(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  testSetId: uuid("test_set_id").references(() => testSets.id, { onDelete: "cascade" }).notNull(),
  mode: text("mode").notNull(), // full | retrieval-only
  judgeModel: text("judge_model"),
  status: text("status").notNull().default("pending"), // pending | running | done | cancelled | failed
  totalJobs: integer("total_jobs").notNull().default(0),
  completedJobs: integer("completed_jobs").notNull().default(0),
  createdAt: createdAt(),
});

export const evalRunConfigs = pgTable("eval_run_configs", {
  id: id(),
  runId: uuid("run_id").references(() => evalRuns.id, { onDelete: "cascade" }).notNull(),
  configId: uuid("config_id").references(() => ragConfigs.id, { onDelete: "cascade" }).notNull(),
}, (t) => [uniqueIndex("eval_run_configs_uniq").on(t.runId, t.configId)]);

export const questionResults = pgTable("question_results", {
  id: id(),
  runId: uuid("run_id").references(() => evalRuns.id, { onDelete: "cascade" }).notNull(),
  configId: uuid("config_id").references(() => ragConfigs.id, { onDelete: "cascade" }).notNull(),
  questionId: uuid("question_id").references(() => testQuestions.id, { onDelete: "cascade" }).notNull(),
  retrieved: jsonb("retrieved").$type<Array<{ chunkId: string; rank: number; score: number }>>(),
  hit: boolean("hit"),
  reciprocalRank: doublePrecision("reciprocal_rank"),
  answer: text("answer"),
  faithfulness: doublePrecision("faithfulness"),
  correctness: doublePrecision("correctness"),
  judgeRaw: jsonb("judge_raw"),
  status: text("status").notNull().default("pending"), // pending | done | failed
  error: text("error"),
}, (t) => [
  uniqueIndex("question_results_uniq").on(t.runId, t.configId, t.questionId),
  index("question_results_run_idx").on(t.runId),
]);

export const attributions = pgTable("attributions", {
  id: id(),
  resultId: uuid("result_id").references(() => questionResults.id, { onDelete: "cascade" }).notNull(),
  verdict: text("verdict").notNull(), // chunking | embedding | retrieval | unanswerable
  counterfactuals: jsonb("counterfactuals").notNull(),
  explanation: text("explanation"),
  evidenceChunkIds: jsonb("evidence_chunk_ids").$type<string[]>(),
  createdAt: createdAt(),
});
