import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { documents, projects, testQuestions, testSets } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import type { Session } from "next-auth";

/**
 * This route lives outside `/projects/:projectId`, so there is no path segment to run
 * `requireProject` against -- org-scoping instead walks the ownership chain
 * question set -> project -> organizationId, and any break in that chain (unknown set, or a set
 * owned by a different org) reads the same as "not found" rather than leaking existence.
 */
export async function listQuestions(testSetId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  const [owner] = await db.select({ organizationId: projects.organizationId })
    .from(testSets)
    .innerJoin(projects, eq(projects.id, testSets.projectId))
    .where(eq(testSets.id, testSetId));
  if (!owner || owner.organizationId !== session.user.organizationId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // A failed set can still hold questions generated before the failure -- review treats them
  // like any other set's, so the set's own status is irrelevant here.
  const rows = await db.select({
    id: testQuestions.id,
    documentId: testQuestions.documentId,
    filename: documents.filename,
    question: testQuestions.question,
    goldAnswer: testQuestions.goldAnswer,
    goldStart: testQuestions.goldStart,
    goldEnd: testQuestions.goldEnd,
  }).from(testQuestions)
    .innerJoin(documents, eq(documents.id, testQuestions.documentId))
    .where(and(eq(testQuestions.testSetId, testSetId), eq(testQuestions.status, "active")));

  return NextResponse.json({ questions: rows });
}

export async function GET(_req: Request, { params }: { params: Promise<{ testSetId: string }> }) {
  const { testSetId } = await params;
  return listQuestions(testSetId, await auth());
}
