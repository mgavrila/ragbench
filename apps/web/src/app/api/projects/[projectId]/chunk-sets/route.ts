import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { chunks, chunkSets } from "@ragbench/db";
import { hashParams, lookupEmbeddingModel } from "@ragbench/core";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import { sendJob } from "@/lib/queue";
import type { Session } from "next-auth";

// Each chunker gets its own closed param schema. An open `z.record` let a client pick the window
// sizes the worker's chunking loops run on -- {"maxTokens": 500000} on a large corpus is a cheap
// way to pin a worker for a very long time -- so the bounds below are the contract, and unknown
// keys are rejected rather than silently stored and hashed into the set's identity.
const CHUNKER_SCHEMAS = {
  fixed: z.strictObject({
    maxTokens: z.int().min(1).max(2000).optional(),
    overlapTokens: z.int().min(0).max(500).optional(),
  }),
  heading: z.strictObject({
    maxChars: z.int().min(100).max(50_000).optional(),
  }),
  "sentence-window": z.strictObject({
    windowSentences: z.int().min(1).max(50).optional(),
    overlapSentences: z.int().min(0).max(10).optional(),
  }),
} as const;

const CreateChunkSet = z.discriminatedUnion("chunker", [
  z.object({ chunker: z.literal("fixed"), params: CHUNKER_SCHEMAS.fixed.optional(), embedModel: z.string().optional() }),
  z.object({ chunker: z.literal("heading"), params: CHUNKER_SCHEMAS.heading.optional(), embedModel: z.string().optional() }),
  z.object({
    chunker: z.literal("sentence-window"),
    params: CHUNKER_SCHEMAS["sentence-window"].optional(),
    embedModel: z.string().optional(),
  }),
]);

export async function listChunkSets(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await getDb()
    .select({
      id: chunkSets.id,
      projectId: chunkSets.projectId,
      chunker: chunkSets.chunker,
      params: chunkSets.params,
      paramsHash: chunkSets.paramsHash,
      createdAt: chunkSets.createdAt,
      chunkCount: sql<number>`count(${chunks.id})`.mapWith(Number),
    })
    .from(chunkSets)
    .leftJoin(chunks, eq(chunks.chunkSetId, chunkSets.id))
    .where(eq(chunkSets.projectId, projectId))
    .groupBy(chunkSets.id);

  return NextResponse.json({ chunkSets: rows });
}

export async function createChunkSet(
  projectId: string, req: Request, session: Session | null,
  send: (queue: string, data: object, key: string) => Promise<void> = sendJob,
) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = CreateChunkSet.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { chunker, embedModel } = parsed.data;
  const params: Record<string, unknown> = parsed.data.params ?? {};
  if (embedModel && !lookupEmbeddingModel(embedModel)) {
    return NextResponse.json({ error: `unknown embedding model: ${embedModel}` }, { status: 400 });
  }

  const paramsHash = hashParams(params);
  const db = getDb();
  const inserted = await db.insert(chunkSets)
    .values({ projectId, chunker, params, paramsHash })
    .onConflictDoNothing()
    .returning();

  let chunkSet = inserted[0];
  let status = 201;
  if (!chunkSet) {
    const [existing] = await db.select().from(chunkSets)
      .where(and(eq(chunkSets.projectId, projectId), eq(chunkSets.chunker, chunker), eq(chunkSets.paramsHash, paramsHash)));
    chunkSet = existing;
    status = 200;
  }

  // Only the chunk job is sent, even when embedding was requested: chunkHandler enqueues embed
  // itself once its rebuild has committed. Sending both from here raced -- embed could start
  // against the previous rebuild's chunks (or none at all) and then find nothing left to do.
  //
  // Both the created and the existing-set path enqueue, so re-POSTing an existing set re-chunks
  // the project's current documents and re-embeds them. That is the point: documents uploaded
  // after the set was created are otherwise never chunked into it. The chunk queue is exclusive on
  // this singletonKey, so a re-POST while a rebuild is already in flight is dropped by pg-boss
  // rather than queued twice.
  try {
    await send(
      "chunk",
      { chunkSetId: chunkSet.id, embedModel, organizationId: session.user.organizationId },
      chunkSet.id,
    );
  } catch {
    // The set row exists but nothing is scheduled for it. Recoverable: re-POSTing the same
    // chunker+params returns this same set (200) and enqueues again.
    return NextResponse.json({ error: "failed to schedule chunking", chunkSetId: chunkSet.id }, { status: 500 });
  }

  return NextResponse.json({ chunkSet }, { status });
}

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return listChunkSets(projectId, await auth());
}

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return createChunkSet(projectId, req, await auth());
}
