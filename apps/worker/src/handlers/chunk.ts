import { and, eq } from "drizzle-orm";
import { chunkSets, chunks, computeFingerprint, documents } from "@ragbench/db";
import { CHUNKERS } from "@ragbench/core";
import { enqueue, type JobHandler } from "../queue";

// Postgres caps a single statement at 65,535 bind parameters. Each chunk row binds 6 (chunkSetId,
// documentId, idx, text, startOffset, endOffset), so one statement tops out around 10,922 rows;
// 5,000 keeps a comfortable margin below that.
const INSERT_BATCH_SIZE = 5000;

export const chunkHandler: JobHandler<{
  chunkSetId: string;
  organizationId?: string;
}> = async ({ chunkSetId, organizationId }, { db, boss }) => {
  const [set] = await db.select().from(chunkSets).where(eq(chunkSets.id, chunkSetId));
  if (!set) return;
  const chunker = CHUNKERS[set.chunker];
  if (!chunker) throw new Error(`unknown chunker: ${set.chunker}`);
  const docs = await db.select().from(documents)
    .where(and(eq(documents.projectId, set.projectId), eq(documents.status, "ready")));

  const fingerprint = computeFingerprint(set.paramsHash, docs.map((d) => d.contentHash));
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
      // A successful rebuild clears any stale advisory error left by reconcile.ts's stuck-build
      // detection (see reconcile.ts): that write only ever happens when this same transaction
      // never completed, so completing it now is proof the set is no longer stuck and the message
      // would otherwise linger on the corpus page forever, describing a problem that already healed.
      await tx.update(chunkSets)
        .set({ docsFingerprint: fingerprint, embedError: null })
        .where(eq(chunkSets.id, chunkSetId));
    });
  }

  // Enqueued whether or not the block above rebuilt: a skipped rebuild still needs embedding
  // chained so a newly-requested model gets embedded (skip-existing makes an already-embedded
  // model a cheap no-op). Enqueued only after any rebuild transaction above has committed, so the
  // embed job is guaranteed to see the chunks it is meant to embed. A failure here (or a crash
  // before it) leaves the chunks built but unembedded; pg-boss retries the whole job, and both
  // halves are idempotent -- the rebuild replaces the same rows and embed skips chunks it has
  // already embedded.
  //
  // Read fresh (not from the `set` selected at the top) rather than trusting the payload: the
  // chunk-sets route appends a requested model to the row before it enqueues this job, but a
  // concurrent re-POST can append a second model while this job's rebuild above is still running.
  // Reading post-commit picks that model up too instead of dropping it -- the set remembers every
  // model it was ever asked to embed, and a rebuild re-chains all of them.
  if (organizationId) {
    const [current] = await db.select({ embedModels: chunkSets.embedModels })
      .from(chunkSets).where(eq(chunkSets.id, chunkSetId));
    for (const model of current?.embedModels ?? []) {
      await enqueue(boss, "embed", { chunkSetId, model, organizationId }, `${chunkSetId}:${model}`);
    }
  }
};
