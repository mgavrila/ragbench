import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chunkSets, chunks, documents } from "@ragbench/db";
import { CHUNKERS } from "@ragbench/core";
import { enqueue, type JobHandler } from "../queue";

// Postgres caps a single statement at 65,535 bind parameters. Each chunk row binds 6 (chunkSetId,
// documentId, idx, text, startOffset, endOffset), so one statement tops out around 10,922 rows;
// 5,000 keeps a comfortable margin below that.
const INSERT_BATCH_SIZE = 5000;

// Identifies "nothing that would change the chunks has changed since the last rebuild": the
// chunker params (via the set's already-stored paramsHash) and the exact set of ready documents'
// content (via their contentHashes, sorted so document order doesn't matter). A doc flipping to
// "ready" or "duplicate"/"failed" changes which contentHashes are in the join, so it changes the
// fingerprint and forces a rebuild.
export function computeFingerprint(paramsHash: string, readyDocs: { contentHash: string }[]): string {
  const sortedHashes = readyDocs.map((d) => d.contentHash).sort().join(",");
  return createHash("sha256").update(`${paramsHash}:${sortedHashes}`).digest("hex");
}

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

  const fingerprint = computeFingerprint(set.paramsHash, docs);
  const [existingChunk] = await db.select({ id: chunks.id }).from(chunks)
    .where(eq(chunks.chunkSetId, chunkSetId)).limit(1);

  // Rebuild-skip: re-POSTing a chunk set with unchanged params and unchanged ready-doc content is
  // a cost bug waiting to happen (full delete-and-recreate on every retry). Skip the teardown when
  // the fingerprint already matches and the set actually has chunks -- the `existingChunk` check
  // guards the edge case where the fingerprint matches by coincidence (e.g. still null-adjacent)
  // but the chunks were removed some other way, which must still force a rebuild.
  if (fingerprint === set.docsFingerprint && existingChunk) {
    // fall through to the embed chaining below without touching chunks
  } else {
    // Any failure inside this transaction (chunker throwing, insert failing) propagates and is not
    // caught here: the set's chunks are left as they were before the transaction started (delete
    // and inserts roll back together), so pg-boss retrying the job is safe and won't leave a
    // partial rebuild behind. The fingerprint is written in the same transaction so it never
    // records a rebuild that didn't actually commit.
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
      await tx.update(chunkSets).set({ docsFingerprint: fingerprint }).where(eq(chunkSets.id, chunkSetId));
    });
  }

  // Enqueued whether or not the block above rebuilt: a skipped rebuild still needs embedding
  // chained so a newly-requested model gets embedded (skip-existing makes an already-embedded
  // model a cheap no-op). Enqueued only after any rebuild transaction above has committed, so the
  // embed job is guaranteed to see the chunks it is meant to embed. A failure here (or a crash
  // before it) leaves the chunks built but unembedded; pg-boss retries the whole job, and both
  // halves are idempotent -- the rebuild replaces the same rows and embed skips chunks it has
  // already embedded.
  if (embedModel && organizationId) {
    await enqueue(boss, "embed", { chunkSetId, model: embedModel, organizationId }, `${chunkSetId}:${embedModel}`);
  }
};
