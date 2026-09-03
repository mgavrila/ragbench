import { and, eq, sql } from "drizzle-orm";
import {
  evalRuns, makeUsageReporter, questionResults, ragConfigs, testQuestions, type Db,
} from "@ragbench/db";
import {
  ProviderError, buildAnswerPrompt, buildJudgePrompt, evaluateRetrieval, makeEmbedder, makeLLM,
  mockAnswer, mockJudge, parseJudgeJson, type JudgeResult, type UsageReporter,
} from "@ragbench/core";
import type { PgBoss } from "pg-boss";
import { retrieveTopK } from "../retrieve";

// An answer grounded in a handful of excerpts is a paragraph, not an essay; the judge returns one
// small JSON object. Both caps exist so a rambling model cannot turn one question into a large bill.
const ANSWER_MAX_TOKENS = 400;
const JUDGE_MAX_TOKENS = 300;

/** Demo-mode model id. Routed to the deterministic pure functions instead of any provider call. */
const MOCK_LLM = "mock-llm";

type ResultKey = { runId: string; configId: string; questionId: string };
type ResultFields = Omit<typeof questionResults.$inferInsert, "runId" | "configId" | "questionId" | "id">;

function keyFilter(key: ResultKey) {
  return and(
    eq(questionResults.runId, key.runId),
    eq(questionResults.configId, key.configId),
    eq(questionResults.questionId, key.questionId),
  );
}

/**
 * Writes the one result row for (run, config, question), replacing a previous FAILED attempt.
 *
 * The row is unique on that triple, so this is an upsert with a deliberate asymmetry: a failed row
 * is deleted first (a retry after a provider outage must be able to overwrite it with a real
 * result), while a row that already succeeded is left exactly as it was -- `onConflictDoNothing`
 * makes a re-delivered job idempotent instead of rewriting a result with a second, independently
 * embedded and judged one. Both statements run in one transaction so a crash between them cannot
 * leave the question with no row at all.
 */
async function writeResult(db: Db, key: ResultKey, fields: ResultFields): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(questionResults)
      .where(and(keyFilter(key), eq(questionResults.status, "failed")));
    await tx.insert(questionResults).values({ ...key, ...fields }).onConflictDoNothing();
  });
}

/**
 * Recomputes the run's progress from the result rows themselves rather than incrementing a counter.
 * An increment would drift the moment a job is delivered twice (pg-boss guarantees at-least-once):
 * the count is the truth, and re-running it is free. Failed rows count too -- a question that will
 * never succeed still accounts for its job, or one provider failure would hang the run at 99%.
 */
async function recordProgress(db: Db, runId: string): Promise<void> {
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
  if (!run) return;
  const [counted] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(questionResults).where(eq(questionResults.runId, runId));
  const completed = counted?.n ?? 0;
  await db.update(evalRuns).set({ completedJobs: completed }).where(eq(evalRuns.id, runId));
  // Guarded on `running` so a run cancelled while its last jobs were in flight is not flipped to
  // done behind the user's back.
  if (run.totalJobs > 0 && completed >= run.totalJobs) {
    await db.update(evalRuns).set({ status: "done" })
      .where(and(eq(evalRuns.id, runId), eq(evalRuns.status, "running")));
  }
}

// `embedderFactory`/`llmFactory` default to the real provider factories and exist only so a test
// can inject a stub that fails deterministically -- the real SDKs cannot be made to produce a
// classified ProviderError on demand without network or valid-looking credentials (same reasoning
// as embedHandler, apps/worker/src/handlers/embed.ts). Not annotated as JobHandler<T> (which fixes
// the call signature at exactly two params) so tests can pass the extra arguments; the optional
// params still leave this assignable wherever a JobHandler<T> is expected (see main.ts).
export const evaluateQuestionHandler = async (
  { runId, configId, questionId, organizationId }: {
    runId: string; configId: string; questionId: string; organizationId: string;
  },
  { db }: { db: Db; boss: PgBoss },
  embedderFactory: typeof makeEmbedder = makeEmbedder,
  llmFactory: typeof makeLLM = makeLLM,
): Promise<void> => {
  const key: ResultKey = { runId, configId, questionId };

  const [existing] = await db.select().from(questionResults).where(keyFilter(key));
  // A row that is not `failed` is this job's finished work: nothing left to compute. Progress is
  // still recomputed, because the crash this re-delivery is recovering from may have happened
  // between writing the row and accounting for it.
  if (existing && existing.status !== "failed") {
    await recordProgress(db, runId);
    return;
  }

  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
  if (!run) return;
  // A cancelled or failed run stops spending: in-flight jobs for it write nothing.
  if (run.status === "cancelled" || run.status === "failed") return;

  const [config] = await db.select().from(ragConfigs).where(eq(ragConfigs.id, configId));
  const [question] = await db.select().from(testQuestions).where(eq(testQuestions.id, questionId));
  // Missing rows are an integrity problem no retry fixes (the FKs on question_results would reject
  // the write anyway), so the job no-ops. A question with status `deleted` is deliberately NOT
  // skipped: start-run snapshotted the ACTIVE questions when it fanned out, and a question deleted
  // mid-run is still evaluated so the run's grid stays rectangular and its progress can complete.
  // Acceptable for v1; the alternative (retiring the job and shrinking totalJobs) needs bookkeeping
  // this doesn't earn yet.
  if (!config || !question) return;

  const reporter = makeUsageReporter(db, organizationId);
  // Embedding providers report their own usage under purpose "embed" -- they were written for
  // corpus embedding. A run's per-question query embeds are a different cost centre (one call per
  // question per config, on every run), so they are re-labelled here to stay separable in the ledger.
  const queryEmbedReporter: UsageReporter = (usage) => reporter({ ...usage, purpose: "query-embed" });

  let answer: string | null = null;
  let judge: JudgeResult | null = null;
  let judgeRaw: { raw: string } | null = null;
  let retrieved: Awaited<ReturnType<typeof retrieveTopK>>;

  try {
    // Constructed inside the try so a provider SDK throwing from its constructor (malformed key,
    // unsupported option) is attributed like any other provider failure instead of escaping.
    const embedder = embedderFactory(config.embeddingModel, queryEmbedReporter);
    const [queryEmbedding] = await embedder.embed([question.question]);
    retrieved = await retrieveTopK(db, {
      chunkSetId: config.chunkSetId,
      model: config.embeddingModel,
      queryEmbedding,
      k: config.topK,
    });

    if (run.mode === "full") {
      const chunkTexts = retrieved.map((r) => r.text);
      // answerModel is optional: a run that only pinned a judge answers with it too, rather than
      // failing over a field the user never had to fill in.
      const answerModel = run.answerModel ?? run.judgeModel;
      if (answerModel) {
        answer = answerModel === MOCK_LLM
          ? mockAnswer(question.question, chunkTexts)
          : await llmFactory(answerModel, reporter, "answer").complete({
              prompt: buildAnswerPrompt(question.question, chunkTexts),
              maxTokens: ANSWER_MAX_TOKENS,
            });
      }
      if (answer !== null && run.judgeModel) {
        if (run.judgeModel === MOCK_LLM) {
          judge = mockJudge(question.goldAnswer, answer);
          // Stored in the same shape as a real judge's reply -- the mock's scores ARE what a
          // well-behaved judge would have returned -- so the drill-down UI has one shape to render.
          judgeRaw = { raw: JSON.stringify(judge) };
        } else {
          const raw = await llmFactory(run.judgeModel, reporter, "judge").complete({
            prompt: buildJudgePrompt(question.question, question.goldAnswer, answer, chunkTexts),
            maxTokens: JUDGE_MAX_TOKENS,
          });
          // Kept whether or not it parsed: an unparseable reply leaves the scores null (an
          // unscored answer, not a zero-scored one, which would poison the averages) and this is
          // the only record of what the judge actually said.
          judgeRaw = { raw };
          judge = parseJudgeJson(raw);
        }
      }
    }
  } catch (err) {
    // House failure policy. A non-retryable provider failure (bad key, model rejects the request)
    // belongs to this question: the row records it and the job returns, so the rest of the run
    // still produces results instead of the whole grid dying with it. A retryable failure (rate
    // limit, transient fault) and anything that is not a ProviderError (a DB fault, a bug here)
    // propagate untouched for pg-boss to retry.
    if (err instanceof ProviderError && !err.retryable) {
      await writeResult(db, key, { status: "failed", error: err.message });
      await recordProgress(db, runId);
      return;
    }
    throw err;
  }

  // INHERITED CAVEAT (do not "fix" here): verifyQuote, which produced these gold spans during
  // test-set generation, resolves a quote to its FIRST occurrence in the document. On a repetitive
  // corpus the passage the question was actually written from may be a LATER occurrence, so
  // retrieval that correctly finds that later occurrence overlaps a different span and scores as a
  // miss. hit@k and MRR are therefore a conservative lower bound on real retrieval quality, never
  // an overstatement. Plan 5 is aware.
  const { hit, reciprocalRank } = evaluateRetrieval(
    retrieved.map((r) => ({ documentId: r.documentId, span: { start: r.startOffset, end: r.endOffset } })),
    { documentId: question.documentId, span: { start: question.goldStart, end: question.goldEnd } },
  );

  await writeResult(db, key, {
    // Rank is 1-based and stored rather than left implicit in array order, so the drill-down UI and
    // any later attribution pass read the same numbering this run's reciprocal rank was computed from.
    retrieved: retrieved.map((r, i) => ({ chunkId: r.chunkId, rank: i + 1, score: r.score })),
    hit,
    reciprocalRank,
    answer,
    faithfulness: judge?.faithfulness ?? null,
    correctness: judge?.correctness ?? null,
    judgeRaw,
    status: "done",
    error: null,
  });

  await recordProgress(db, runId);
};
