import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { attributions, evalRuns, projects, questionResults } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { parseUuid } from "@/lib/params";
import type { Session } from "next-auth";
import type { StoredCounterfactuals } from "@/lib/attribution";

/**
 * Polling contract: `attributions` has no failed/pending state of its own -- a diagnose that never
 * started, is still running, or failed non-retryably (silent, per ruling) all read back the same
 * way here: `{ attribution: null }`. The UI's recovery path is re-clicking Diagnose after a bounded
 * wait, not distinguishing those cases from this response. `resultStatus` rides along so the caller
 * can still say something about the cell (e.g. "still evaluating") while attribution stays null,
 * without a second round trip. See `StoredCounterfactuals` (apps/worker/src/handlers/attribute.ts)
 * for what actually lands in `attributions.counterfactuals`.
 */
export async function getAttribution(resultId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!parseUuid(resultId)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const db = getDb();
  const [owner] = await db.select({ organizationId: projects.organizationId, status: questionResults.status })
    .from(questionResults)
    .innerJoin(evalRuns, eq(evalRuns.id, questionResults.runId))
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(eq(questionResults.id, resultId));
  if (!owner || owner.organizationId !== session.user.organizationId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [row] = await db.select().from(attributions).where(eq(attributions.resultId, resultId));
  const attribution = row
    ? { ...row, counterfactuals: row.counterfactuals as StoredCounterfactuals }
    : null;

  return NextResponse.json({ attribution, resultStatus: owner.status });
}

export async function GET(_req: Request, { params }: { params: Promise<{ resultId: string }> }) {
  const { resultId } = await params;
  return getAttribution(resultId, await auth());
}
