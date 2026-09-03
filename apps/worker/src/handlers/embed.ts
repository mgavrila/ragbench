import { and, eq, notExists } from "drizzle-orm";
import { chunkEmbeddings, chunks, makeUsageReporter } from "@ragbench/db";
import { lookupEmbeddingModel, makeEmbedder } from "@ragbench/core";
import type { JobHandler } from "../queue";

// No status field on chunks/chunk_embeddings owns "embedding failed" (spec §4 note): both
// retryable and non-retryable ProviderErrors are simply rethrown here so pg-boss either retries
// the job or fails it visibly. Do not catch-and-mark here.
export const embedHandler: JobHandler<{ chunkSetId: string; model: string; organizationId: string }> =
  async ({ chunkSetId, model, organizationId }, { db }) => {
    const dimension = lookupEmbeddingModel(model)?.dimension;
    if (!dimension) throw new Error(`unknown embedding model: ${model}`);
    const embedder = makeEmbedder(model, makeUsageReporter(db, organizationId));

    const pending = await db.select().from(chunks).where(and(
      eq(chunks.chunkSetId, chunkSetId),
      notExists(
        db.select().from(chunkEmbeddings).where(and(
          eq(chunkEmbeddings.chunkId, chunks.id),
          eq(chunkEmbeddings.model, model),
        )),
      ),
    ));

    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      const vectors = await embedder.embed(batch.map((c) => c.text));
      await db.insert(chunkEmbeddings)
        .values(batch.map((c, j) => ({ chunkId: c.id, model, dimension, embedding: vectors[j] })))
        .onConflictDoNothing();
    }
  };
