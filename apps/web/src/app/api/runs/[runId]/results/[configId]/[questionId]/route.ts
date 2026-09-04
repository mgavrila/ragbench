import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { chunks, documents, evalRuns, projects, questionResults, testQuestions } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { parseUuid } from "@/lib/params";
import type { Session } from "next-auth";

/**
 * Cell drill-down: the one (run, config, question) row, with its retrieved chunks hydrated with
 * the text and filename the grid never carries (those live on chunks/documents, not on the
 * question_results row itself, which only stores chunkId/rank/score).
 *
 * Org-scoped the same way as run detail: walk run -> project -> organizationId.
 */
export async function getResultCell(runId: string, configId: string, questionId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // All three segments reach a uuid column, so all three are checked -- a valid runId with a
  // malformed configId would otherwise pass the ownership query and fail on the row lookup.
  if (!parseUuid(runId) || !parseUuid(configId) || !parseUuid(questionId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const db = getDb();
  const [owner] = await db.select({ organizationId: projects.organizationId })
    .from(evalRuns)
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(eq(evalRuns.id, runId));
  if (!owner || owner.organizationId !== session.user.organizationId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [result] = await db.select().from(questionResults)
    .where(and(
      eq(questionResults.runId, runId),
      eq(questionResults.configId, configId),
      eq(questionResults.questionId, questionId),
    ));
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [question] = await db.select({
      id: testQuestions.id,
      question: testQuestions.question,
      goldAnswer: testQuestions.goldAnswer,
      goldStart: testQuestions.goldStart,
      goldEnd: testQuestions.goldEnd,
    })
    .from(testQuestions)
    .where(eq(testQuestions.id, questionId));

  const chunkIds = (result.retrieved ?? []).map((r) => r.chunkId);
  const chunkRows = chunkIds.length > 0
    ? await db.select({ id: chunks.id, text: chunks.text, filename: documents.filename })
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.documentId))
        .where(inArray(chunks.id, chunkIds))
    : [];
  const chunkById = new Map(chunkRows.map((c) => [c.id, c]));
  // Order preserved from `retrieved` (already rank-ordered by evaluate-question), not from the
  // hydration query, which has no defined order over an IN-list.
  const retrieved = (result.retrieved ?? []).map((r) => ({
    ...r,
    text: chunkById.get(r.chunkId)?.text ?? null,
    filename: chunkById.get(r.chunkId)?.filename ?? null,
  }));

  return NextResponse.json({ result: { ...result, retrieved }, question });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string; configId: string; questionId: string }> },
) {
  const { runId, configId, questionId } = await params;
  return getResultCell(runId, configId, questionId, await auth());
}
