import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  chunkSets, computeFingerprint, documents, evalRunConfigs, evalRuns, ragConfigs, testQuestions, testSets,
} from "@ragbench/db";
import { lookupLlmModel } from "@ragbench/core";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import { sendJob } from "@/lib/queue";
import type { Session } from "next-auth";

const CreateRun = z.object({
  testSetId: z.uuid(),
  configIds: z.array(z.uuid()).min(1).max(6),
  mode: z.enum(["full", "retrieval-only"]),
  judgeModel: z.string().min(1).default("mock-llm"),
  answerModel: z.string().min(1).optional(),
});

export async function listRuns(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await getDb()
    .select({
      id: evalRuns.id,
      projectId: evalRuns.projectId,
      testSetId: evalRuns.testSetId,
      testSetName: testSets.name,
      mode: evalRuns.mode,
      status: evalRuns.status,
      error: evalRuns.error,
      totalJobs: evalRuns.totalJobs,
      completedJobs: evalRuns.completedJobs,
      createdAt: evalRuns.createdAt,
    })
    .from(evalRuns)
    .innerJoin(testSets, eq(testSets.id, evalRuns.testSetId))
    .where(eq(evalRuns.projectId, projectId))
    .orderBy(desc(evalRuns.createdAt));

  return NextResponse.json({ runs: rows });
}

export async function createRun(
  projectId: string, req: Request, session: Session | null,
  send: (queue: string, data: object, key: string) => Promise<void> = sendJob,
) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = CreateRun.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { testSetId, mode, judgeModel, answerModel } = parsed.data;
  // Duplicate ids in the request collapse to one config: they would otherwise double-count in the
  // 1..6 bound and in the staleness/fan-out work below for no benefit.
  const configIds = [...new Set(parsed.data.configIds)];

  if (!lookupLlmModel(judgeModel)) {
    return NextResponse.json({ error: `unknown judge model: ${judgeModel}` }, { status: 400 });
  }
  if (answerModel && !lookupLlmModel(answerModel)) {
    return NextResponse.json({ error: `unknown answer model: ${answerModel}` }, { status: 400 });
  }

  const db = getDb();

  const [testSet] = await db.select().from(testSets)
    .where(and(eq(testSets.id, testSetId), eq(testSets.projectId, projectId)));
  if (!testSet) return NextResponse.json({ error: "not found" }, { status: 404 });

  // A `failed` test set (generation errored out partway) is still runnable as long as it left
  // behind at least one active question -- only a set with zero questions to draw on is rejected.
  const [{ n: activeQuestions }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(testQuestions)
    .where(and(eq(testQuestions.testSetId, testSetId), eq(testQuestions.status, "active")));
  if (activeQuestions === 0) {
    return NextResponse.json({ error: "test set has no active questions" }, { status: 400 });
  }

  const configs = await db.select().from(ragConfigs)
    .where(and(inArray(ragConfigs.id, configIds), eq(ragConfigs.projectId, projectId)));
  if (configs.length !== configIds.length) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Staleness pre-flight: recompute each config's chunk set's fingerprint from the project's
  // CURRENT ready documents and compare against the fingerprint stamped at its last rebuild. A
  // mismatch means documents have been added/changed since, so newly-ready ones live in no chunk
  // set at all -- retrieval against them would be a guaranteed miss misdiagnosed as unanswerable,
  // rather than a corpus the config genuinely hasn't been rebuilt against.
  const readyDocs = await db.select({ contentHash: documents.contentHash })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.status, "ready")));
  const contentHashes = readyDocs.map((d) => d.contentHash);

  const chunkSetIds = [...new Set(configs.map((c) => c.chunkSetId))];
  const sets = await db.select().from(chunkSets).where(inArray(chunkSets.id, chunkSetIds));
  const setById = new Map(sets.map((s) => [s.id, s]));

  const staleConfigIds: string[] = [];
  // Chunk sets have no name of their own -- the message names the config instead ("config X's
  // chunk set"), which doesn't imply chunk sets have names of their own.
  let staleConfigName: string | undefined;
  for (const config of configs) {
    const set = setById.get(config.chunkSetId);
    if (!set) continue;
    const current = computeFingerprint(set.paramsHash, contentHashes);
    if (current !== set.docsFingerprint) {
      staleConfigIds.push(config.id);
      staleConfigName ??= config.name;
    }
  }
  if (staleConfigIds.length > 0) {
    return NextResponse.json(
      { error: `config "${staleConfigName}"'s chunk set is stale -- rebuild it before running`, staleConfigIds },
      { status: 409 },
    );
  }

  // One transaction: a run row whose config rows failed to insert is a run start-run would fan out
  // to zero configs, reaching `done` with an empty grid and no indication anything went wrong.
  const run = await db.transaction(async (tx) => {
    const [created] = await tx.insert(evalRuns)
      .values({ projectId, testSetId, mode, judgeModel, answerModel: answerModel ?? null })
      .returning();
    await tx.insert(evalRunConfigs).values(configIds.map((configId) => ({ runId: created.id, configId })));
    return created;
  });

  try {
    await send("start-run", { runId: run.id, organizationId: session.user.organizationId }, run.id);
  } catch (err) {
    // The run and its configs exist but nothing is scheduled: mark it failed in place (house
    // failure philosophy, matching test-sets/chunk-sets) rather than leaving it stuck at "pending"
    // forever. Recoverable: re-enqueuing start-run for this same run id is the documented retry.
    await db.update(evalRuns)
      .set({
        status: "failed",
        error: `failed to schedule run: ${err instanceof Error ? err.message : String(err)}`,
      })
      .where(eq(evalRuns.id, run.id));
    return NextResponse.json({ error: "failed to schedule run", runId: run.id }, { status: 500 });
  }

  return NextResponse.json({ run }, { status: 201 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return listRuns(projectId, await auth());
}

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return createRun(projectId, req, await auth());
}
