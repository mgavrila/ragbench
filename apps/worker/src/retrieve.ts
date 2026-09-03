import { and, eq, sql } from "drizzle-orm";
import { chunkEmbeddings, chunks, type Db } from "@ragbench/db";

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  startOffset: number;
  endOffset: number;
  text: string;
  /** Cosine similarity in [-1, 1] (1 - cosine distance); higher is nearer. */
  score: number;
};

/**
 * Top-k nearest chunks in one chunk set under one embedding model, by cosine distance.
 *
 * PINNED: the distance operator is cosine (`<=>`) and must stay cosine. Gemini's embedding API
 * returns vectors truncated to a requested dimension WITHOUT re-normalizing them, so their
 * magnitudes vary; under inner product (`<#>`) or L2 (`<->`) that leftover magnitude becomes part
 * of the score and longer vectors win regardless of direction. Cosine divides it out, so it is the
 * only operator that ranks truncated and un-truncated embeddings on the same footing. Any pgvector
 * index added later must therefore use `vector_cosine_ops`, or it will silently not be used here.
 *
 * The embedding is bound as a parameter and cast (`::vector`) rather than interpolated, so a
 * dimension mismatch surfaces as a Postgres error instead of a wrong ranking.
 */
export async function retrieveTopK(
  db: Db,
  opts: { chunkSetId: string; model: string; queryEmbedding: number[]; k: number },
): Promise<RetrievedChunk[]> {
  if (opts.k <= 0 || opts.queryEmbedding.length === 0) return [];
  const query = `[${opts.queryEmbedding.join(",")}]`;
  const distance = sql<number>`${chunkEmbeddings.embedding} <=> ${query}::vector`;

  return db.select({
    chunkId: chunks.id,
    documentId: chunks.documentId,
    startOffset: chunks.startOffset,
    endOffset: chunks.endOffset,
    text: chunks.text,
    score: sql<number>`1 - (${distance})`.mapWith(Number),
  })
    .from(chunks)
    .innerJoin(chunkEmbeddings, eq(chunkEmbeddings.chunkId, chunks.id))
    .where(and(eq(chunks.chunkSetId, opts.chunkSetId), eq(chunkEmbeddings.model, opts.model)))
    // Ties (two chunks at the same distance, common when a query shares no vocabulary with either)
    // would otherwise come back in whatever order the scan produced, so the chunk id breaks them:
    // a re-run of the same job ranks the same way, which is what makes reciprocal rank reproducible.
    .orderBy(distance, chunks.id)
    .limit(opts.k);
}
