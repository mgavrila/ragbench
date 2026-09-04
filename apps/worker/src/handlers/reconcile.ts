import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { chunkSets, documents, evalRuns, projects, type Db } from "@ragbench/db";
import type { PgBoss } from "pg-boss";
import { enqueue, type JobHandler } from "../queue";

const MINUTE_MS = 60_000;
const RUN_STUCK_MS = 10 * MINUTE_MS;
const CHUNK_SET_STUCK_MS = 15 * MINUTE_MS;
const DOCUMENT_STUCK_MS = 15 * MINUTE_MS;

/**
 * How many pg-boss jobs on `queue` are still created/retrying/active for one payload key. Reads
 * pg-boss's own `job` table directly (partitioned by queue name, so this is one partition, not a
 * full-table scan) rather than through the pg-boss API: `fetch`/`work` consume jobs and
 * `getQueueStats` counts a whole queue, but nothing answers "is there still a live job for THIS
 * run/document/chunk-set" -- which is exactly what tells a run still fanning out apart from one
 * whose worker died mid-flight. `pgboss` is the default schema (see PgBoss's own DEFAULT_SCHEMA);
 * this worker never overrides it, so the name is safe to hardcode rather than plumb through.
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
 * A run whose worker died mid-fan-out: `running`, older than the window, not yet complete, and
 * with no evaluate-question job still in flight for it. `completedJobs`/`totalJobs` and the
 * evaluate-question payload's `runId` are start-run's own contract (see start-run.ts), so this
 * reads the same signals a human would when deciding whether to re-click "start run".
 *
 * Age is read off `createdAt` (eval_runs has no `updatedAt` -- see schema.ts) even though that is
 * the row's insert time, not when it entered `running`. A run retried after `failed` reuses the
 * same row, so a long-lived run that failed once and was restarted recently could in principle be
 * reconciled sooner than 10 minutes of *this* attempt's own running time. That is judged
 * acceptable: the no-active-jobs check is what actually gates re-enqueuing, so the worst case is
 * an extra (idempotent, harmless) start-run re-send, never a run cut off while genuinely working.
 */
async function reconcileStuckRuns(db: Db, boss: PgBoss): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_STUCK_MS);
  const stuck = await db.select({ run: evalRuns, organizationId: projects.organizationId })
    .from(evalRuns)
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(and(eq(evalRuns.status, "running"), lt(evalRuns.createdAt, cutoff)));

  for (const { run, organizationId } of stuck) {
    if (run.completedJobs >= run.totalJobs) continue; // finishing naturally; recordProgress will land it
    const active = await activeJobCount(db, "evaluate-question", "runId", run.id);
    if (active > 0) continue; // still working
    console.log(
      `reconcile: run ${run.id} stuck running (${run.completedJobs}/${run.totalJobs} jobs, no ` +
        "active evaluate-question jobs) -- re-enqueuing start-run",
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
