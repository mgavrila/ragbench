import { and, eq } from "drizzle-orm";
import { chunkSets, chunks, documents } from "@ragbench/db";
import { CHUNKERS } from "@ragbench/core";
import type { JobHandler } from "../queue";

export const chunkHandler: JobHandler<{ chunkSetId: string }> = async ({ chunkSetId }, { db }) => {
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
      await tx.insert(chunks).values(pieces.map((p, idx) => ({
        chunkSetId, documentId: doc.id, idx,
        text: p.text, startOffset: p.startOffset, endOffset: p.endOffset,
      })));
    }
  });
};
