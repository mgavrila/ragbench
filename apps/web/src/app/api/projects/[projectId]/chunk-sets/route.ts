import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { chunkEmbeddings, chunks, chunkSets } from "@ragbench/db";
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

  const db = getDb();
  const rows = await db
    .select({
      id: chunkSets.id,
      projectId: chunkSets.projectId,
      chunker: chunkSets.chunker,
      params: chunkSets.params,
      paramsHash: chunkSets.paramsHash,
      embedModels: chunkSets.embedModels,
      embedError: chunkSets.embedError,
      createdAt: chunkSets.createdAt,
      chunkCount: sql<number>`count(${chunks.id})`.mapWith(Number),
    })
    .from(chunkSets)
    .leftJoin(chunks, eq(chunks.chunkSetId, chunkSets.id))
    .where(eq(chunkSets.projectId, projectId))
    .groupBy(chunkSets.id);

  // `embedModels` is every model ever REQUESTED for the set; a model is only usable for retrieval
  // once vectors exist for EVERY chunk in the set. The two diverge for as long as an embed job is
  // queued, running, or has failed partway, and a config built against a model in either of those
  // states produces a run that startRunHandler refuses outright. Reported as its own list (rather
  // than filtering embedModels down) so the picker can still show a requested-but-not-yet-usable
  // model, greyed out, instead of silently dropping the model the user just asked for.
  //
  // Kept out of the aggregate query above: joining chunk_embeddings there would multiply the rows
  // count(chunks.id) sees, turning chunkCount into chunks x models.
  //
  // Probed per (set, requested model) pair rather than aggregated over the whole project's
  // chunks-to-embeddings join. That DISTINCT walked every vector in the project to answer a
  // question about a handful of pairs, and it grew with the corpus while the answer did not. Each
  // pair's count here is an index lookup per chunk (chunks_set_idx, then chunk_embeddings_uniq on
  // (chunk_id, model)), and the pair list comes from the sets' own embed_models. A model with
  // vectors but never recorded in embed_models therefore does not appear -- nothing removes from
  // that array, and the route that requests an embedding appends to it before enqueueing, so in
  // practice it is a superset of what has vectors.
  const coverage = await db.execute<{ chunk_set_id: string; model: string; embedded: number }>(sql`
    select cs.id as chunk_set_id, m.model as model, cov.embedded as embedded
    from ${chunkSets} cs
    cross join lateral jsonb_array_elements_text(cs.embed_models) as m(model)
    cross join lateral (
      select count(*)::int as embedded
      from ${chunks} c
      join ${chunkEmbeddings} ce on ce.chunk_id = c.id and ce.model = m.model
      where c.chunk_set_id = cs.id
    ) cov
    where cs.project_id = ${projectId}
  `);

  const coverageBySet = new Map<string, Array<{ model: string; embedded: number }>>();
  for (const row of coverage.rows) {
    const list = coverageBySet.get(row.chunk_set_id) ?? [];
    list.push({ model: row.model, embedded: row.embedded });
    coverageBySet.set(row.chunk_set_id, list);
  }

  return NextResponse.json({
    chunkSets: rows.map((r) => {
      // `total` is the set's own chunk count from the aggregate above, so a half-finished embed job
      // shows up as embedded < total. An empty set (total 0) has no usable model at all.
      const models = (coverageBySet.get(r.id) ?? [])
        .map((c) => ({ model: c.model, embedded: c.embedded, total: r.chunkCount }));
      return {
        ...r,
        // Usable for a run: every chunk in the set has a vector under this model.
        embeddedModels: models.filter((m) => m.total > 0 && m.embedded === m.total).map((m) => m.model),
        // Per-model counts, so the UI can say WHY a requested model is not usable yet ("3/16
        // chunks embedded") instead of only greying it out.
        modelCoverage: models,
      };
    }),
  });
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

  // The set remembers every embedding model it has ever been asked for, appended here (before the
  // chunk job is enqueued) rather than carried in the job payload. Two independent races are in
  // play and each has its own defence:
  //
  //  1. Lost update between two concurrent POSTs for DIFFERENT models. Read-modify-write in the
  //     request (read embedModels, append in JS, write the whole array back) loses whichever append
  //     commits second. So the append is one statement: postgres does the concatenation, and the
  //     `@>` guard in the WHERE makes it a no-op when the model is already there, which keeps a
  //     re-POST for the same model from duplicating the entry.
  //  2. A rebuild already in flight when the append lands. chunkHandler re-reads embedModels off
  //     the row after its own commit rather than trusting a payload snapshot, so a model appended
  //     after the chunk job started is still picked up and embedded.
  if (embedModel) {
    const modelJson = JSON.stringify([embedModel]);
    await db.execute(sql`
      update ${chunkSets}
      set embed_models = ${chunkSets.embedModels} || ${modelJson}::jsonb
      where ${chunkSets.id} = ${chunkSet.id}
        and not (${chunkSets.embedModels} @> ${modelJson}::jsonb)
    `);
    // Re-read rather than RETURNING: the response should show the row as it stands after every
    // concurrent append, not just this request's contribution to it.
    const [refreshed] = await db.select().from(chunkSets).where(eq(chunkSets.id, chunkSet.id));
    chunkSet = refreshed;
  }

  // Only the chunk job is sent, even when embedding was requested: chunkHandler enqueues embed
  // itself once its rebuild has committed. Sending both from here raced -- embed could start
  // against the previous rebuild's chunks (or none at all) and then find nothing left to do.
  //
  // Both the created and the existing-set path enqueue, so re-POSTing an existing set re-chunks
  // the project's current documents and re-embeds them (every model the set has ever been asked
  // for, per the embedModels append above). That is the point: documents uploaded after the set
  // was created are otherwise never chunked into it. The chunk queue is exclusive on this
  // singletonKey, so a re-POST while a rebuild is already in flight is dropped by pg-boss rather
  // than queued twice.
  try {
    await send(
      "chunk",
      { chunkSetId: chunkSet.id, organizationId: session.user.organizationId },
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
