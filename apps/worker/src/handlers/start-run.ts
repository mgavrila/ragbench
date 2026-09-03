import { and, eq } from "drizzle-orm";
import {
  chunkEmbeddings, chunks, evalRunConfigs, evalRuns, ragConfigs, testQuestions, type Db,
} from "@ragbench/db";
import { enqueue, type JobHandler } from "../queue";

/**
 * Terminal run-level failure: no retry can turn any of these into a success (a config pointing at a
 * chunk set that was never embedded for its model stays that way until a human rebuilds it), so the
 * run is marked failed with an explanation and the job returns rather than throwing and burning
 * pg-boss's retries on it. Mirrors how parse/generate-testset attribute failures to their entity.
 */
async function failRun(db: Db, runId: string, error: string): Promise<void> {
  await db.update(evalRuns).set({ status: "failed", error }).where(eq(evalRuns.id, runId));
}

export const startRunHandler: JobHandler<{ runId: string; organizationId: string }> =
  async ({ runId, organizationId }, { db, boss }) => {
    const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
    if (!run) return; // deleted meanwhile -- idempotent no-op
    // A finished or cancelled run is never re-fanned-out: a re-delivered job must not resurrect it.
    // A `failed` run IS re-fanned-out, so re-enqueuing start-run is how a user retries one after
    // fixing what it named (embedding the chunk set, adding a config).
    if (run.status === "done" || run.status === "cancelled") return;

    // Ordered so the fan-out (and therefore the enqueue order) is stable across retries.
    const configRows = await db.select({ config: ragConfigs })
      .from(evalRunConfigs)
      .innerJoin(ragConfigs, eq(ragConfigs.id, evalRunConfigs.configId))
      .where(eq(evalRunConfigs.runId, runId))
      .orderBy(ragConfigs.createdAt, ragConfigs.id);
    const configs = configRows.map((r) => r.config);
    if (configs.length === 0) {
      // Not merely "nothing to do": totalJobs would be 0, no evaluate-question job would ever run,
      // and nothing would advance the run past `running` -- it would hang there forever. Failing it
      // is what makes the empty case visible instead of silently stuck.
      await failRun(db, runId, "run has no configs");
      return;
    }

    // Active questions only, snapshotted here: this is the moment the run's question set is fixed.
    const questions = await db.select({ id: testQuestions.id })
      .from(testQuestions)
      .where(and(eq(testQuestions.testSetId, run.testSetId), eq(testQuestions.status, "active")))
      .orderBy(testQuestions.id);
    if (questions.length === 0) {
      await failRun(db, runId, "test set has no active questions");
      return;
    }

    // Every config must be able to retrieve at all. Without these checks a config that cannot
    // retrieve produces a full grid of zero-hit rows, which reads as "this config is terrible at
    // retrieval" when the truth is that it never ran -- exactly the misdiagnosis this product
    // exists to prevent. Both are terminal: no retry changes a stored topK or an unembedded set.
    for (const config of configs) {
      // topK below 1 asks for no chunks at all. The API validates 1..50, so this catches hand-made
      // or hand-edited rows before they turn into a grid of guaranteed misses.
      if (config.topK < 1) {
        await failRun(
          db,
          runId,
          `config "${config.name}" has topK ${config.topK}, which retrieves nothing -- it must be at least 1`,
        );
        return;
      }
      const [embedded] = await db.select({ id: chunkEmbeddings.id })
        .from(chunkEmbeddings)
        .innerJoin(chunks, eq(chunks.id, chunkEmbeddings.chunkId))
        .where(and(
          eq(chunks.chunkSetId, config.chunkSetId),
          eq(chunkEmbeddings.model, config.embeddingModel),
        ))
        .limit(1);
      if (!embedded) {
        await failRun(
          db,
          runId,
          `config "${config.name}" has no embeddings for ${config.embeddingModel} in its chunk set ` +
            `-- rebuild and embed the chunk set, then start the run again`,
        );
        return;
      }
    }

    // `error` is cleared here so a run retried after a fixed configuration does not keep displaying
    // the failure it just recovered from.
    await db.update(evalRuns)
      .set({ status: "running", totalJobs: configs.length * questions.length, error: null })
      .where(eq(evalRuns.id, runId));

    // One job per (config, question). The singleton key must be distinct per job: these queues use
    // pg-boss's "exclusive" policy, under which jobs sharing a key cannot be created/active at the
    // same time -- a shared key would serialise the whole fan-out into one job at a time and drop
    // the rest. Re-running start-run re-enqueues everything: keys dedupe whatever is still in
    // flight, and jobs whose results already landed short-circuit on their existing row.
    for (const config of configs) {
      for (const question of questions) {
        await enqueue(
          boss,
          "evaluate-question",
          { runId, configId: config.id, questionId: question.id, organizationId },
          `${runId}:${config.id}:${question.id}`,
        );
      }
    }
  };
