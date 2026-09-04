import { and, eq, sql } from "drizzle-orm";
import {
  chunkEmbeddings, chunkSets, chunks, evalRunConfigs, evalRuns, projects, ragConfigs, testQuestions,
  type Db,
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
    const [row] = await db.select({ run: evalRuns, organizationId: projects.organizationId })
      .from(evalRuns)
      .innerJoin(projects, eq(projects.id, evalRuns.projectId))
      .where(eq(evalRuns.id, runId));
    if (!row) return; // deleted meanwhile -- idempotent no-op
    const { run } = row;
    // The payload's organizationId is only ever used to meter usage, and the route that enqueues
    // this job derives it from the run's own ownership chain. Cross-checking it against that chain
    // here means a job whose payload was tampered with (or crafted by hand against the queue) bills
    // nothing to the org it names instead of charging one org for another's run. It is a no-op, not
    // a run failure: the run itself is fine, and re-enqueuing it correctly is the fix.
    if (row.organizationId !== organizationId) {
      console.error(
        `start-run job for run ${runId} claims organization ${organizationId} but the run belongs ` +
          `to ${row.organizationId}; ignoring`,
      );
      return;
    }
    // A finished or cancelled run is never re-fanned-out: a re-delivered job must not resurrect it.
    // A `failed` run IS re-fanned-out, so re-enqueuing start-run is how a user retries one after
    // fixing what it named (embedding the chunk set, adding a config).
    if (run.status === "done" || run.status === "cancelled") return;

    // Ordered so the fan-out (and therefore the enqueue order) is stable across retries. The chunk
    // set rides along so the checks below can name it the way the rest of the product does
    // (`chunker (paramsHash prefix)`) instead of printing a bare uuid at the user.
    const configRows = await db.select({ config: ragConfigs, set: chunkSets })
      .from(evalRunConfigs)
      .innerJoin(ragConfigs, eq(ragConfigs.id, evalRunConfigs.configId))
      .innerJoin(chunkSets, eq(chunkSets.id, ragConfigs.chunkSetId))
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
    for (const { config, set } of configRows) {
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
      // Counted, not probed. "At least one vector exists" was too weak: an embed job that died
      // partway leaves a set where retrieval silently ranks only the chunks that got vectors, so
      // every question whose answer lives in the unembedded remainder misses for a reason that has
      // nothing to do with the config -- the misdiagnosis this product exists to prevent, and the
      // one that also breaks the goldInSingleChunk => bestGoldRank invariant a later diagnose
      // depends on. The left join cannot inflate `total`: chunk_embeddings is unique on
      // (chunk_id, model), so each chunk matches at most one row.
      const [coverage] = await db.select({
        total: sql<number>`count(*)`.mapWith(Number),
        embedded: sql<number>`count(${chunkEmbeddings.chunkId})`.mapWith(Number),
      })
        .from(chunks)
        .leftJoin(chunkEmbeddings, and(
          eq(chunkEmbeddings.chunkId, chunks.id),
          eq(chunkEmbeddings.model, config.embeddingModel),
        ))
        .where(eq(chunks.chunkSetId, config.chunkSetId));
      const total = coverage?.total ?? 0;
      const embedded = coverage?.embedded ?? 0;
      if (embedded === 0) {
        await failRun(
          db,
          runId,
          `config "${config.name}" has no embeddings for ${config.embeddingModel} in its chunk set ` +
            `-- rebuild and embed the chunk set, then start the run again`,
        );
        return;
      }
      if (embedded < total) {
        await failRun(
          db,
          runId,
          `config "${config.name}" has embeddings for only ${embedded} of ${total} chunks in chunk ` +
            `set "${set.chunker} (${set.paramsHash.slice(0, 8)})" under ${config.embeddingModel} ` +
            `-- the embed job did not finish; re-embed the chunk set, then start the run again`,
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
