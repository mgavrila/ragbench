import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { evalRunConfigs, evalRuns, projects, questionResults, ragConfigs, testQuestions } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import type { Session } from "next-auth";

/** `avg` comes back as a string or null over the pg driver; this keeps a null aggregate null (no
 * scored rows yet) instead of `Number(null)` silently becoming 0. */
function nullableNumber(v: unknown): number | null {
  return v === null ? null : Number(v);
}

/**
 * Org-scoped outside `/projects/:projectId`, same shape as the questions routes: walk
 * run -> project -> organizationId. Any break in that chain is a 404.
 */
export async function getRun(runId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  const [row] = await db.select({ run: evalRuns, organizationId: projects.organizationId })
    .from(evalRuns)
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(eq(evalRuns.id, runId));
  if (!row || row.organizationId !== session.user.organizationId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { run } = row;

  // The question count is the same for every config in the run (it's the test set's active-question
  // snapshot start-run fanned out against), so it's computed once rather than per config.
  const [{ questions }] = await db.select({ questions: sql<number>`count(*)`.mapWith(Number) })
    .from(testQuestions)
    .where(and(eq(testQuestions.testSetId, run.testSetId), eq(testQuestions.status, "active")));

  // AGGREGATES RULING: a `failed` row may still carry a real hit/reciprocalRank (retrieval
  // succeeded; only the answer or judge failed), so hitRate/mrr average over rows WHERE hit IS NOT
  // NULL regardless of status -- not just `done` rows, or a judge outage would erase real retrieval
  // signal from the aggregate. faithfulness/correctness average their own non-null values.
  // `evaluated`/`failed` are counts of status, which IS what those labels mean in the UI.
  //
  // Left-joined so a config with zero result rows yet still appears (one null-filled group) rather
  // than being silently absent from the response before its first job lands.
  const configRows = await db.select({
      id: ragConfigs.id,
      name: ragConfigs.name,
      chunkSetId: ragConfigs.chunkSetId,
      embeddingModel: ragConfigs.embeddingModel,
      topK: ragConfigs.topK,
      createdAt: ragConfigs.createdAt,
      evaluated: sql<number>`count(*) filter (where ${questionResults.status} = 'done')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${questionResults.status} = 'failed')`.mapWith(Number),
      hitRate: sql`avg(case when ${questionResults.hit} then 1.0 else 0.0 end) filter (where ${questionResults.hit} is not null)`.mapWith(nullableNumber),
      mrr: sql`avg(${questionResults.reciprocalRank}) filter (where ${questionResults.hit} is not null)`.mapWith(nullableNumber),
      avgFaithfulness: sql`avg(${questionResults.faithfulness})`.mapWith(nullableNumber),
      avgCorrectness: sql`avg(${questionResults.correctness})`.mapWith(nullableNumber),
    })
    .from(evalRunConfigs)
    .innerJoin(ragConfigs, eq(ragConfigs.id, evalRunConfigs.configId))
    .leftJoin(
      questionResults,
      and(eq(questionResults.runId, runId), eq(questionResults.configId, evalRunConfigs.configId)),
    )
    .where(eq(evalRunConfigs.runId, runId))
    .groupBy(ragConfigs.id)
    .orderBy(ragConfigs.createdAt, ragConfigs.id);

  const configs = configRows.map((c) => ({
    config: { id: c.id, name: c.name, chunkSetId: c.chunkSetId, embeddingModel: c.embeddingModel, topK: c.topK, createdAt: c.createdAt },
    aggregates: {
      questions, evaluated: c.evaluated, failed: c.failed,
      hitRate: c.hitRate, mrr: c.mrr, avgFaithfulness: c.avgFaithfulness, avgCorrectness: c.avgCorrectness,
    },
  }));

  const questionRows = await db.select({ id: testQuestions.id, question: testQuestions.question })
    .from(testQuestions)
    .where(and(eq(testQuestions.testSetId, run.testSetId), eq(testQuestions.status, "active")))
    .orderBy(testQuestions.id);

  const cells = await db.select({
      configId: questionResults.configId,
      questionId: questionResults.questionId,
      hit: questionResults.hit,
      reciprocalRank: questionResults.reciprocalRank,
      status: questionResults.status,
    })
    .from(questionResults)
    .where(eq(questionResults.runId, runId));

  const perQuestion = new Map<string, Record<string, { hit: boolean | null; reciprocalRank: number | null; status: string }>>();
  for (const q of questionRows) perQuestion.set(q.id, {});
  for (const cell of cells) {
    const bucket = perQuestion.get(cell.questionId);
    if (!bucket) continue; // a question deleted mid-run: still evaluated (see evaluate-question), excluded from this grid
    bucket[cell.configId] = { hit: cell.hit, reciprocalRank: cell.reciprocalRank, status: cell.status };
  }
  const grid = questionRows.map((q) => ({ questionId: q.id, question: q.question, perConfig: perQuestion.get(q.id) ?? {} }));

  return NextResponse.json({ run, configs, grid });
}

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return getRun(runId, await auth());
}
