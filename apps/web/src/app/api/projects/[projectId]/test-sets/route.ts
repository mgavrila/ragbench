import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { testQuestions, testSets } from "@ragbench/db";
import { lookupLlmModel } from "@ragbench/core";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import { sendJob } from "@/lib/queue";
import type { Session } from "next-auth";

const CreateTestSet = z.object({
  name: z.string().min(1),
  generatorModel: z.string().min(1),
  questionsTarget: z.int().min(1).max(200).default(30),
});

export async function listTestSets(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Only active questions count towards the reviewer-visible total -- deleted ones were rejected
  // during review and should not make a set look richer than what a run would actually draw on.
  const rows = await getDb()
    .select({
      id: testSets.id,
      projectId: testSets.projectId,
      name: testSets.name,
      generatorModel: testSets.generatorModel,
      status: testSets.status,
      error: testSets.error,
      questionsTarget: testSets.questionsTarget,
      createdAt: testSets.createdAt,
      questionCount: sql<number>`count(${testQuestions.id})`.mapWith(Number),
    })
    .from(testSets)
    .leftJoin(testQuestions, and(eq(testQuestions.testSetId, testSets.id), eq(testQuestions.status, "active")))
    .where(eq(testSets.projectId, projectId))
    .groupBy(testSets.id);

  return NextResponse.json({ testSets: rows });
}

export async function createTestSet(
  projectId: string, req: Request, session: Session | null,
  send: (queue: string, data: object, key: string) => Promise<void> = sendJob,
) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = CreateTestSet.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { name, generatorModel, questionsTarget } = parsed.data;
  if (!lookupLlmModel(generatorModel)) {
    return NextResponse.json({ error: `unknown generator model: ${generatorModel}` }, { status: 400 });
  }

  const db = getDb();
  // No upsert: test sets are point-in-time snapshots of the corpus, so every POST -- even one
  // that repeats an earlier name/model/target -- starts a brand new set and a brand new run.
  const [testSet] = await db.insert(testSets)
    .values({ projectId, name, generatorModel, questionsTarget })
    .returning();

  try {
    await send("generate-testset", { testSetId: testSet.id, organizationId: session.user.organizationId }, testSet.id);
  } catch {
    // The row exists but nothing is scheduled for it. Unlike chunk-sets (upsert on conflict), a
    // retry here cannot just re-POST into the same row -- so the row is marked failed in place,
    // visible in the list rather than stuck at "generating" forever with no explanation.
    await db.update(testSets)
      .set({ status: "failed", error: "failed to schedule generation" })
      .where(eq(testSets.id, testSet.id));
    return NextResponse.json({ error: "failed to schedule generation", testSetId: testSet.id }, { status: 500 });
  }

  return NextResponse.json({ testSet }, { status: 201 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return listTestSets(projectId, await auth());
}

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return createTestSet(projectId, req, await auth());
}
