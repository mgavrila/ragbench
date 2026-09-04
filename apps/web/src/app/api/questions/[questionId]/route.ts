import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { projects, testQuestions, testSets } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { parseUuid } from "@/lib/params";
import type { Session } from "next-auth";

/**
 * Also outside `/projects/:projectId` -- org-scoping walks question -> test set -> project ->
 * organizationId, same as the questions-listing route. Any break in that chain is a 404.
 */
export async function deleteQuestion(questionId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!parseUuid(questionId)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const db = getDb();
  const [owner] = await db.select({ organizationId: projects.organizationId })
    .from(testQuestions)
    .innerJoin(testSets, eq(testSets.id, testQuestions.testSetId))
    .innerJoin(projects, eq(projects.id, testSets.projectId))
    .where(eq(testQuestions.id, questionId));
  if (!owner || owner.organizationId !== session.user.organizationId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Soft delete: the row stays for audit/history, just excluded from active review and from
  // whatever future generation resumes against the set (see generate-testset.ts's resume count).
  await db.update(testQuestions).set({ status: "deleted" }).where(eq(testQuestions.id, questionId));
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ questionId: string }> }) {
  const { questionId } = await params;
  return deleteQuestion(questionId, await auth());
}
