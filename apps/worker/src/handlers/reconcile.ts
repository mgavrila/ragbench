import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { chunkSets, documents, evalRuns, projects, type Db } from "@ragbench/db";
import type { PgBoss } from "pg-boss";
import { enqueue, type JobHandler } from "../queue";

const MINUTE_MS = 60_000;
const RUN_STUCK_MS = 10 * MINUTE_MS;
const CHUNK_SET_STUCK_MS = 15 * MINUTE_MS;
const DOCUMENT_STUCK_MS = 15 * MINUTE_MS;
// Past this, a run is not "still recoverable", it's abandoned: reconcile runs every 5 minutes, so
// leaving re-enqueue unbounded would re-send start-run roughly 288 times a day forever for a run
// nothing can actually rescue (e.g. every provider call exhausting its retries). House failure
// philosophy is a terminal, visible failure instead -- see failRun in start-run.ts.
const RUN_ABANDON_MS = 24 * 60 * MINUTE_MS;

/**
 * How many pg-boss jobs on `queue` are still created/retrying/active for one payload key. Reads
 * pg-boss's own `job` table directly rather than through the pg-boss API: `fetch`/`work` consume
 * jobs and `getQueueStats` counts a whole queue, but nothing answers "is there still a live job for
 * THIS run/document/chunk-set" -- which is exactly what tells a run still fanning out apart from
 * one whose worker died mid-flight. pg-boss partitions this table by queue name by default (see its
 * plans.js -- `noTablePartitioning` defaults to false, and this worker never sets it), so a
 * `name = $1` filter is typically a single-partition lookup rather than a scan of every queue's
 * jobs; that partitioning is pg-boss's own migration output, not something this query controls or
 * verifies at runtime. `pgboss` is the default schema (see PgBoss's own DEFAULT_SCHEMA); this
 * worker never overrides it, so the name is safe to hardcode rather than plumb through.
 */
async function activeJobCount(
  db: Db,
  queue: string,
  payloadKey: string,
  payloadValue: string,
): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from pgboss.job
    where name = ${queue}
      and state in ('created', 'retry', 'active')
      and data ->> ${payloadKey} = ${payloadValue}
  `);
  return result.rows[0]?.n ?? 0;
}

/**
 * A run whose worker died mid-flight, in any of the three states that leaves it stranded:
 *  - `running`, not yet complete, no evaluate-question job in flight -- start-run itself finished
 *    the fan-out but the jobs it created never all landed (see start-run.ts's contract for
 *    `totalJobs`/`completedJobs` and the evaluate-question payload's `runId`).
 *  - `pending`, no start-run job in flight -- the route that creates a run enqueues start-run
 *    immediately (see apps/web's runs route), so a pending run with nothing live for it means that
 *    very first job never ran at all (send failed, or the worker died before picking it up).
 *  - `running`, every job actually done (`completedJobs >= totalJobs`), no evaluate-question job in
 *    flight -- recordProgress (evaluate-question.ts) writes the completedJobs count and flips
 *    status to `done` in two separate, un-transacted statements; a worker that dies between them
 *    leaves the run exactly here, permanently. This one does not mean "re-enqueue" (there is
 *    nothing left to run) -- it means finish the flip the interrupted job never made.
 * All three read as "no retry could still be coming" the same way: if pg-boss shows nothing
 * created/retrying/active for this runId on the queue that would be advancing it, nothing is.
 *
 * Age is read off `createdAt` (eval_runs has no `updatedAt` -- see schema.ts) even though that is
 * the row's insert time, not when it entered `running`/stayed `pending`. A run retried after
 * `failed` reuses the same row, so a long-lived run that failed once and was restarted recently
 * could in principle be reconciled sooner than 10 minutes of *this* attempt's own time in that
 * status. That is judged acceptable: the no-active-jobs check is what actually gates re-enqueuing,
 * so the worst case is an extra (idempotent, harmless) start-run re-send, never a run cut off while
 * genuinely working.
 *
 * Past RUN_ABANDON_MS, "no live job" stops meaning "re-enqueue" and starts meaning "give up":
 * without this a run every provider call keeps failing for (retries exhausted, or a human never
 * comes back to fix a `failed` run's cause) gets re-sent roughly every 5 minutes forever. Failing
 * it visibly is the same house philosophy as start-run's own failRun -- a run nothing can rescue
 * ends in `failed` with a reason, not silent perpetual re-billing.
 */
async function reconcileStuckRuns(db: Db, boss: PgBoss): Promise<void> {
  const stuckCutoff = new Date(Date.now() - RUN_STUCK_MS);
  const abandonCutoff = new Date(Date.now() - RUN_ABANDON_MS);
  const stuck = await db.select({ run: evalRuns, organizationId: projects.organizationId })
    .from(evalRuns)
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(and(inArray(evalRuns.status, ["running", "pending"]), lt(evalRuns.createdAt, stuckCutoff)));

  for (const { run, organizationId } of stuck) {
    const liveQueue = run.status === "pending" ? "start-run" : "evaluate-question";
    const active = await activeJobCount(db, liveQueue, "runId", run.id);

    // totalJobs is 0 until start-run computes it, so this check only makes sense once a run has
    // actually started fanning out -- a pending run's 0 >= 0 would otherwise look "finished".
    if (run.status === "running" && run.totalJobs > 0 && run.completedJobs >= run.totalJobs) {
      if (active > 0) continue; // still finishing naturally -- the last job(s) are still landing
      // Every job is done and none are still live, yet the run itself never flipped to `done` --
      // recordProgress died between its two statements (see the docstring above). Guarded on
      // `running` so a run cancelled in the same window is not resurrected.
      console.log(`reconcile: run ${run.id} completed all ${run.totalJobs} jobs but never flipped to done -- marking done`);
      await db.update(evalRuns).set({ status: "done" })
        .where(and(eq(evalRuns.id, run.id), eq(evalRuns.status, "running")));
      continue;
    }

    if (active > 0) continue; // still working

    if (run.createdAt < abandonCutoff) {
      const reason = run.status === "pending"
        ? "run did not start within 24h and no start-run job is running -- a job likely exhausted " +
          "its retries; re-create the run to retry"
        : `run did not complete within 24h; ${run.completedJobs} of ${run.totalJobs} jobs finished ` +
          "-- a job likely exhausted its retries; re-create the run to retry";
      console.log(`reconcile: run ${run.id} abandoned (${run.status}, no live ${liveQueue} job) -- marking failed`);
      await db.update(evalRuns).set({ status: "failed", error: reason }).where(eq(evalRuns.id, run.id));
      continue;
    }

    console.log(
      `reconcile: run ${run.id} stuck ${run.status} (no active ${liveQueue} jobs) -- re-enqueuing start-run`,
    );
    // Same key start-run's own enqueuer uses (see apps/web's runs route): "exclusive" policy makes
    // a second send while one is already in flight a safe no-op, so a duplicate reconcile tick or a
    // human retrying at the same moment cannot double-fan-out.
    await enqueue(boss, "start-run", { runId: run.id, organizationId }, run.id);
  }
}

/**
 * A chunk set stuck mid-(re)build: chunkHandler writes `docsFingerprint` only inside the same
 * transaction as its chunk inserts, so a null fingerprint is "never finished a build" (see
 * chunk.ts). chunk_sets has neither a `status` column nor an `updatedAt` one (see schema.ts) --
 * unlike documents/eval_runs there is no dedicated terminal-failure field for a build, so this
 * reuses `embedError`, the one field the corpus page already renders in red for this row (see
 * corpus-client.tsx). That also means a STALE rebuild (fingerprint set from a prior successful
 * build, but out of date because new documents arrived) is not caught here -- only a set that has
 * never completed its first build. Catching a stuck re-chunk of an already-built set needs a real
 * status column, which is out of scope for this pass.
 */
async function reconcileStuckChunkSets(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - CHUNK_SET_STUCK_MS);
  const stuck = await db.select().from(chunkSets)
    .where(and(isNull(chunkSets.docsFingerprint), lt(chunkSets.createdAt, cutoff)));

  for (const set of stuck) {
    const [chunkActive, embedActive] = await Promise.all([
      activeJobCount(db, "chunk", "chunkSetId", set.id),
      activeJobCount(db, "embed", "chunkSetId", set.id),
    ]);
    if (chunkActive > 0 || embedActive > 0) continue;
    console.log(`reconcile: chunk set ${set.id} stuck building, no active chunk/embed jobs -- marking failed`);
    await db.update(chunkSets).set({
      embedError:
        "build did not complete within 15 minutes and no chunk/embed job is running -- " +
        "re-submit this chunker and params from the corpus page to rebuild",
    }).where(eq(chunkSets.id, set.id));
  }
}

/** A document stuck in `parsing` with no parse job in flight for it. Mirrors parseHandler's own
 * failure attribution (documents.status/error), just triggered by absence instead of a thrown error. */
async function reconcileStuckDocuments(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - DOCUMENT_STUCK_MS);
  const stuck = await db.select().from(documents)
    .where(and(eq(documents.status, "parsing"), lt(documents.createdAt, cutoff)));

  for (const doc of stuck) {
    const active = await activeJobCount(db, "parse", "documentId", doc.id);
    if (active > 0) continue;
    console.log(`reconcile: document ${doc.id} stuck parsing, no active parse job -- marking failed`);
    await db.update(documents).set({
      status: "failed",
      error: "parsing did not complete within 15 minutes and no parse job is running -- re-upload to retry",
    }).where(eq(documents.id, doc.id));
  }
}

/**
 * Runs every 5 minutes (see queue.ts's schedule) and re-derives "stuck" from scratch each time, so
 * it is safe to run concurrently with normal job processing and safe to re-run on the next tick if
 * this one is interrupted: every branch only acts when there is provably no live job for the row,
 * and every write it makes (re-enqueue, or a terminal failure) is itself idempotent.
 */
export const reconcileHandler: JobHandler<Record<string, never>> = async (_data, { db, boss }) => {
  await reconcileStuckRuns(db, boss);
  await reconcileStuckChunkSets(db);
  await reconcileStuckDocuments(db);
};
