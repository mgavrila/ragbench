import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { evalRuns, projects, questionResults } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { parseUuid } from "@/lib/params";
import { sendJob } from "@/lib/queue";
import type { Session } from "next-auth";

/**
 * Org-scoped outside `/projects/:projectId`: walk result -> run -> project -> organizationId, same
 * chain as the run detail and cell drill-down routes. `organizationId` in the enqueued payload comes
 * from THIS chain, never from the request body -- the worker uses it only for usage metering, never
 * for scoping (task-2-report.md).
 */
export async function diagnoseResult(
  resultId: string, session: Session | null,
  send: (queue: string, data: object, key: string) => Promise<void> = sendJob,
) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // A malformed id would otherwise reach Postgres as `eq(uuidColumn, resultId)` and come back as an
  // uncaught "invalid input syntax for type uuid" -- a 500, not a 404. Guarded here before any query.
  if (!parseUuid(resultId)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const db = getDb();
  const [owner] = await db.select({ organizationId: projects.organizationId, hit: questionResults.hit })
    .from(questionResults)
    .innerJoin(evalRuns, eq(evalRuns.id, questionResults.runId))
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(eq(questionResults.id, resultId));
  if (!owner || owner.organizationId !== session.user.organizationId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Diagnosis answers "why did retrieval miss the gold span?", so it is only offered on a row that
  // actually missed. A hit (or a row that has no retrieval result yet -- hit null on a pending or
  // retrieval-failed row) has no miss to explain, and spending a matrix of counterfactual
  // retrievals plus an LLM call on one is a bill for an answer nobody asked for. Rejected here
  // rather than in the worker: the handler stays permissive on purpose (it is total over hit and
  // miss alike, and the evidence view still renders a diagnosis that already exists), so this is
  // the gate on what gets STARTED.
  if (owner.hit !== false) {
    return NextResponse.json(
      { error: "diagnosis explains retrieval misses; this result hit" },
      { status: 409 },
    );
  }

  try {
    // singletonKey = resultId is MANDATORY (task-2-report.md): the `attribute` queue is exclusive-
    // policy on this key, which -- together with the handler's read-then-insert check -- is what
    // keeps a second click from racing a duplicate row into `attributions`.
    await send("attribute", { resultId, organizationId: owner.organizationId }, resultId);
  } catch (err) {
    // No row of our own to roll back (the worker writes `attributions`, not this route) -- unlike
    // createRun's failure path, there is nothing to mark failed. Diagnose is user-paced and
    // re-clickable, so surfacing the error and letting the caller retry is enough.
    return NextResponse.json(
      { error: `failed to schedule diagnose: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}

export async function POST(_req: Request, { params }: { params: Promise<{ resultId: string }> }) {
  const { resultId } = await params;
  return diagnoseResult(resultId, await auth());
}
