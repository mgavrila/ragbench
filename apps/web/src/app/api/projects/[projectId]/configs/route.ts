import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { chunkSets, ragConfigs } from "@ragbench/db";
import { lookupEmbeddingModel } from "@ragbench/core";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import type { Session } from "next-auth";

const CreateConfig = z.object({
  name: z.string().min(1),
  chunkSetId: z.uuid(),
  embeddingModel: z.string().min(1),
  topK: z.int().min(1).max(50),
});

export async function listConfigs(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  // The chunker/params summary joins in the chunk set the config points at, so the picker UI can
  // show what a config actually runs on without a second round trip.
  const rows = await getDb()
    .select({
      id: ragConfigs.id,
      projectId: ragConfigs.projectId,
      name: ragConfigs.name,
      chunkSetId: ragConfigs.chunkSetId,
      embeddingModel: ragConfigs.embeddingModel,
      topK: ragConfigs.topK,
      createdAt: ragConfigs.createdAt,
      chunker: chunkSets.chunker,
      chunkSetParams: chunkSets.params,
    })
    .from(ragConfigs)
    .innerJoin(chunkSets, eq(chunkSets.id, ragConfigs.chunkSetId))
    .where(eq(ragConfigs.projectId, projectId));

  return NextResponse.json({ configs: rows });
}

export async function createConfig(projectId: string, req: Request, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = CreateConfig.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { name, chunkSetId, embeddingModel, topK } = parsed.data;

  if (!lookupEmbeddingModel(embeddingModel)) {
    return NextResponse.json({ error: `unknown embedding model: ${embeddingModel}` }, { status: 400 });
  }

  const db = getDb();
  const [chunkSet] = await db.select().from(chunkSets)
    .where(and(eq(chunkSets.id, chunkSetId), eq(chunkSets.projectId, projectId)));
  if (!chunkSet) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [config] = await db.insert(ragConfigs)
    .values({ projectId, name, chunkSetId, embeddingModel, topK })
    .returning();

  return NextResponse.json({ config }, { status: 201 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return listConfigs(projectId, await auth());
}

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return createConfig(projectId, req, await auth());
}
