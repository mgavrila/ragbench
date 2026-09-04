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
 * for scoping.
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
  // actually missed. Spending a matrix of counterfactual retrievals plus an LLM call on any other
  // row is a bill for an answer to a question nobody asked. Rejected here rather than in the
  // worker: the handler stays permissive on purpose (it is total over hit and miss alike, and the
  // evidence view still renders a diagnosis that already exists), so this is the gate on what gets
  // STARTED.
  //
  // The two non-miss cases get their own message because they are different situations and the
  // difference is actionable: a hit is finished and will never need diagnosing, while `hit` null
  // (a pending row, or one whose retrieval itself failed) may well become diagnosable once the
  // evaluation lands. Telling the second "this result hit" would be simply false.
  if (owner.hit !== false) {
    return NextResponse.json(
      {
        error: owner.hit === true
          ? "diagnosis explains retrieval misses; this result hit"
          : "diagnosis explains retrieval misses; this result has no retrieval outcome",
      },
      { status: 409 },
    );
  }

  try {
    // singletonKey = resultId is MANDATORY: the `attribute` queue is exclusive-policy on this key,
    // which -- together with the handler's read-then-insert check -- is what keeps a second click
    // from racing a duplicate row into `attributions`.
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
