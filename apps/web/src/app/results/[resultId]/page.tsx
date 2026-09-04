import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { attributions, chunks, documents, evalRuns, projects, questionResults, ragConfigs, testQuestions } from "@ragbench/db";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { EvidenceClient } from "./evidence-client";
import type { StoredCounterfactuals } from "@/lib/attribution";

const ResultId = z.uuid();

/**
 * The evidence view: source document with the gold span highlighted and chunk boundaries overlaid,
 * so "the answer was split across a boundary" is visible at a glance. This is a server component
 * (per plan) that does the full load -- result, question, attribution, gold document text, and the
 * CONFIG's chunk set's offsets for that document -- and hands it to EvidenceClient for rendering and
 * the windowing/Diagnose interactivity. Same org-scoping chain as the run/cell/attribution routes:
 * result -> run -> project -> organizationId.
 */
export default async function ResultPage({ params }: { params: Promise<{ resultId: string }> }) {
  const { resultId } = await params;
  const session = await auth();
  if (!session?.user?.organizationId) redirect("/login");
  // Same guard as the API routes: a malformed id would otherwise reach Postgres as
  // `eq(uuidColumn, resultId)` and throw an uncaught invalid-uuid error, which Next.js turns into a
  // 500 error page rather than the notFound() page a well-formed-but-unknown id gets.
  if (!ResultId.safeParse(resultId).success) notFound();

  const db = getDb();
  const [owner] = await db.select({ result: questionResults, organizationId: projects.organizationId })
    .from(questionResults)
    .innerJoin(evalRuns, eq(evalRuns.id, questionResults.runId))
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(eq(questionResults.id, resultId));
  if (!owner || owner.organizationId !== session.user.organizationId) notFound();
  const { result } = owner;

  const [question] = await db.select().from(testQuestions).where(eq(testQuestions.id, result.questionId));
  const [config] = await db.select().from(ragConfigs).where(eq(ragConfigs.id, result.configId));
  // A broken chain (question or config deleted out from under a historical result) has nothing left
  // to render -- same posture as the worker's no-op on a broken chain.
  if (!question || !config) notFound();

  const [document] = await db.select({ filename: documents.filename, text: documents.text })
    .from(documents).where(eq(documents.id, question.documentId));

  const chunkRows = await db.select({ id: chunks.id, idx: chunks.idx, startOffset: chunks.startOffset, endOffset: chunks.endOffset })
    .from(chunks)
    .where(and(eq(chunks.chunkSetId, config.chunkSetId), eq(chunks.documentId, question.documentId)))
    .orderBy(chunks.idx);

  const [attributionRow] = await db.select().from(attributions).where(eq(attributions.resultId, resultId));
  const attribution = attributionRow
    ? {
        id: attributionRow.id,
        resultId: attributionRow.resultId,
        verdict: attributionRow.verdict as "chunking" | "embedding" | "retrieval" | "unanswerable",
        counterfactuals: attributionRow.counterfactuals as StoredCounterfactuals,
        explanation: attributionRow.explanation,
        evidenceChunkIds: attributionRow.evidenceChunkIds,
      }
    : null;

  return (
    <EvidenceClient
      resultId={resultId}
      runId={result.runId}
      question={{
        question: question.question,
        goldAnswer: question.goldAnswer,
        goldStart: question.goldStart,
        goldEnd: question.goldEnd,
      }}
      doc={{ filename: document?.filename ?? null, text: document?.text ?? null }}
      chunks={chunkRows}
      initialAttribution={attribution}
      initialResultStatus={result.status}
      hit={result.hit}
    />
  );
}
