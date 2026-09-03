import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { chunks, chunkSets } from "@ragbench/db";
import { hashParams, EMBEDDING_MODELS } from "@ragbench/core";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import { sendJob } from "@/lib/queue";
import type { Session } from "next-auth";

const CreateChunkSet = z.object({
  chunker: z.enum(["fixed", "heading", "sentence-window"]),
  params: z.record(z.string(), z.unknown()).optional(),
  embedModel: z.string().optional(),
});

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
  const params = parsed.data.params ?? {};
  if (embedModel && !EMBEDDING_MODELS[embedModel]) {
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

  if (status === 201) {
    await send("chunk", { chunkSetId: chunkSet.id }, chunkSet.id);
    if (embedModel) {
      await send(
        "embed",
        { chunkSetId: chunkSet.id, model: embedModel, organizationId: session.user.organizationId },
        `${chunkSet.id}:${embedModel}`,
      );
    }
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
