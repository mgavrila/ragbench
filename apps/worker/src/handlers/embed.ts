import { and, eq, notExists } from "drizzle-orm";
import { chunkEmbeddings, chunks, chunkSets, makeUsageReporter, type Db } from "@ragbench/db";
import { ProviderError, lookupEmbeddingModel, makeEmbedder } from "@ragbench/core";
import type { PgBoss } from "pg-boss";

// House failure philosophy: chunk_sets.embedError is this handler's owning field for embed
// failures. A non-retryable ProviderError (bad key, model rejects the request -- no retry could
// fix it) is written there and swallowed, so the set shows a terminal, visible error instead of
// pg-boss burning three retries on something that will never succeed. A retryable ProviderError
// (rate limit, transient network fault) is rethrown untouched so pg-boss retries the job. Anything
// that is not a ProviderError (a DB fault, a bug here) also propagates untouched -- only a
// classified provider failure gets attributed to the set.
//
// `factory` defaults to the real provider factory and exists only so a test can inject a stub
// that fails deterministically: the real embedding SDKs either fail over the network (Gemini) or
// can't be made to fail without real, valid-looking credentials being absent in a way that still
// reaches a classified ProviderError (OpenAI's client throws a raw, unclassified error at
// construction with no key), so the credential-stripping trick the LLM handlers use doesn't work
// here on demand. Not typed as JobHandler<T> (which fixes the call signature at exactly two
// params) so tests can pass the third argument directly; the extra optional param still makes
// this assignable wherever a JobHandler<T> is expected (see apps/worker/src/main.ts).
export const embedHandler = async (
  { chunkSetId, model, organizationId }: { chunkSetId: string; model: string; organizationId: string },
  { db }: { db: Db; boss: PgBoss },
  factory: typeof makeEmbedder = makeEmbedder,
): Promise<void> => {
  const dimension = lookupEmbeddingModel(model)?.dimension;
  if (!dimension) throw new Error(`unknown embedding model: ${model}`);
  const reporter = makeUsageReporter(db, organizationId);

  try {
    const embedder = factory(model, reporter);
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
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
      await db.update(chunkSets)
        .set({ embedError: `${model}: ${err.message}` })
        .where(eq(chunkSets.id, chunkSetId));
      return;
    }
    throw err;
  }

  // Simplest correct rule for clearing: any successful embed for any model clears the set's one
  // embedError slot. A set embedding two models where one is broken will keep re-showing that
  // model's failure on every retry of its own embed job, so this does not lose the signal.
  await db.update(chunkSets).set({ embedError: null }).where(eq(chunkSets.id, chunkSetId));
};
