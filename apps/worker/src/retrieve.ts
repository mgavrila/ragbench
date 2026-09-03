import { and, eq, sql } from "drizzle-orm";
import { chunkEmbeddings, chunks, type Db } from "@ragbench/db";
import { ProviderError } from "@ragbench/core";

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
 * only operator that ranks truncated and un-truncated embeddings on the same footing.
 *
 * EXACT SCAN, DELIBERATELY, AND PROBABLY PERMANENTLY: there is no pgvector index here and adding
 * one is not a pending optimisation. An approximate (ANN) index trades recall for speed, and recall
 * is precisely what this query measures -- an index that misses a chunk would be indistinguishable
 * from a retrieval configuration that misses it, so index error would be silently attributed to the
 * user's config. Any index added later must therefore be opt-in (never the default path for a
 * measured run) and must use `vector_cosine_ops`, or it will not be used by this ORDER BY at all.
 *
 * The embedding is bound as a parameter and cast (`::vector`) rather than interpolated, so a
 * dimension mismatch surfaces as a Postgres error instead of a wrong ranking. Known trade-off: the
 * same vector is bound twice (once for the score projection, once for the ORDER BY), costing one
 * extra parameter rather than a CTE or a lateral join to bind it once.
 */
export async function retrieveTopK(
  db: Db,
  opts: { chunkSetId: string; model: string; queryEmbedding: number[]; k: number },
): Promise<RetrievedChunk[]> {
  // Neither of these returns an empty result set: an empty list here is indistinguishable from "the
  // corpus had nothing to offer", so a broken call would be recorded as a confident zero-hit row
  // and read as a bad retrieval configuration. They are separated by whose fault each one is -- an
  // empty vector means the embedding provider misbehaved, so it is classified as a provider failure
  // and lands on the question's row; a topK below 1 is a caller bug that start-run already rejects
  // terminally, so it propagates untouched rather than being dressed up as a provider problem.
  if (opts.queryEmbedding.length === 0) {
    throw new ProviderError("fatal", opts.model, "cannot retrieve with an empty query embedding");
  }
  if (opts.k <= 0) throw new Error(`retrieveTopK requires k >= 1, got ${opts.k}`);
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
