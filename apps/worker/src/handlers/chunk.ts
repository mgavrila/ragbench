import { and, eq } from "drizzle-orm";
import { chunkSets, chunks, documents } from "@ragbench/db";
import { CHUNKERS } from "@ragbench/core";
import { enqueue, type JobHandler } from "../queue";

// Postgres caps a single statement at 65,535 bind parameters. Each chunk row binds 6 (chunkSetId,
// documentId, idx, text, startOffset, endOffset), so one statement tops out around 10,922 rows;
// 5,000 keeps a comfortable margin below that.
const INSERT_BATCH_SIZE = 5000;

export const chunkHandler: JobHandler<{
  chunkSetId: string;
  embedModel?: string;
  organizationId?: string;
}> = async ({ chunkSetId, embedModel, organizationId }, { db, boss }) => {
  const [set] = await db.select().from(chunkSets).where(eq(chunkSets.id, chunkSetId));
  if (!set) return;
  const chunker = CHUNKERS[set.chunker];
  if (!chunker) throw new Error(`unknown chunker: ${set.chunker}`);
  const docs = await db.select().from(documents)
    .where(and(eq(documents.projectId, set.projectId), eq(documents.status, "ready")));
  // Any failure inside this transaction (chunker throwing, insert failing) propagates and is not
  // caught here: the set's chunks are left as they were before the transaction started (delete
  // and inserts roll back together), so pg-boss retrying the job is safe and won't leave a
  // partial rebuild behind.
  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.chunkSetId, chunkSetId));
    for (const doc of docs) {
      if (!doc.text) continue;
      const pieces = chunker(doc.text, set.params);
      if (pieces.length === 0) continue;
      for (let i = 0; i < pieces.length; i += INSERT_BATCH_SIZE) {
        const batch = pieces.slice(i, i + INSERT_BATCH_SIZE);
        await tx.insert(chunks).values(batch.map((p, j) => ({
          chunkSetId, documentId: doc.id, idx: i + j,
          text: p.text, startOffset: p.startOffset, endOffset: p.endOffset,
        })));
      }
    }
  });

  // Enqueued only after the transaction above has committed, so the embed job is guaranteed to see
  // the chunks it is meant to embed. A failure here (or a crash before it) leaves the chunks built
  // but unembedded; pg-boss retries the whole job, and both halves are idempotent -- the rebuild
  // replaces the same rows and embed skips chunks it has already embedded.
  if (embedModel && organizationId) {
    await enqueue(boss, "embed", { chunkSetId, model: embedModel, organizationId }, `${chunkSetId}:${embedModel}`);
  }
};
