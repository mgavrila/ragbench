import { PgBoss } from "pg-boss";
import { createDb, type Db } from "@ragbench/db";

export type JobHandler<T> = (data: T, ctx: { db: Db; boss: PgBoss }) => Promise<void>;

/**
 * The one queue allowed to run more than one job at a time. Each evaluate-question job is a query
 * embed plus up to two LLM round trips, and a run fans out one per (config x question) -- 90 jobs
 * for 3 configs over 30 questions. Serially that is 90 provider round trips end to end; the spec
 * (section 6) calls for a configurable cap instead, default 4.
 *
 * Everything else stays serial. chunk and embed each rebuild a whole set, so two at once on the
 * same set would fight over the same rows, and neither start-run nor parse has a provider call
 * worth overlapping.
 */
const CONCURRENT_QUEUE = "evaluate-question";
const DEFAULT_EVAL_CONCURRENCY = 4;

function evalConcurrency(): number {
  const parsed = Number.parseInt(process.env.RAGBENCH_EVAL_CONCURRENCY ?? "", 10);
  // A missing, non-numeric or nonsensical value falls back to the default rather than failing
  // startup: the cap is a throughput knob, and a typo in it should not take the worker down.
  return Number.isFinite(parsed) ? Math.max(1, parsed) : DEFAULT_EVAL_CONCURRENCY;
}

export async function startWorker(opts: {
  databaseUrl: string;
  handlers: Record<string, JobHandler<any>>;
}) {
  const boss = new PgBoss(opts.databaseUrl);
  const { db, pool } = createDb(opts.databaseUrl);
  await boss.start();

  for (const [name, handler] of Object.entries(opts.handlers)) {
    // `policy: "exclusive"` is what makes enqueue()'s singletonKey idempotent: pg-boss's default
    // "standard" policy does not enforce any uniqueness on singletonKey (it only feeds a throttle
    // index), so two sends with the same key would both succeed. "exclusive" adds a unique index
    // on (queue name, singletonKey) covering created/retry/active state, so a second send with the
    // same key is rejected (send() resolves null) until the first job leaves that state.
    // Trade-off: unkeyed sends on the same queue name all share the implicit empty-string key, so
    // they too run one at a time. Callers that want concurrent jobs on one queue name -- e.g. a
    // fan-out pipeline like evaluate-question enqueuing many jobs -- MUST pass a distinct
    // singletonKey per item (see enqueue() below).
    await boss.createQueue(name, { retryLimit: 3, retryBackoff: true, policy: "exclusive" });
    // createQueue is INSERT ... ON CONFLICT DO NOTHING, so a queue row created by an earlier
    // deployment (or by hand) keeps its original policy and the call above succeeds silently.
    // enqueue()'s dedupe contract depends on "exclusive", so fail loudly instead of running with
    // a policy that quietly stops rejecting duplicate singletonKeys.
    const existing = await boss.getQueue(name);
    if (existing?.policy !== "exclusive") {
      throw new Error(
        `queue "${name}" has policy "${existing?.policy ?? "none"}", expected "exclusive"; ` +
          `pg-boss cannot update an existing queue's policy -- drop it (boss.deleteQueue) and restart`,
      );
    }
    // Concurrency is `localConcurrency` (N independent workers, each fetching and running ONE job)
    // rather than `batchSize` (one worker fetching N jobs into a single handler call). Both would
    // raise throughput, but only localConcurrency preserves per-job failure semantics: pg-boss
    // settles a batch as a unit, so one job throwing out of a batched handler fails and retries
    // every job in that batch alongside it -- re-billing provider calls that already succeeded.
    // With localConcurrency each handler call still owns exactly one job, so a throw retries that
    // job and nothing else, exactly as it did when every queue was serial.
    //
    // Safe under the "exclusive" policy above because that policy is keyed on singletonKey, not on
    // the queue name: start-run gives every evaluate-question job a distinct `${runId}:...` key
    // (see enqueue()), so several are runnable at once. A queue whose jobs share a key still
    // serializes no matter what this is set to.
    const localConcurrency = name === CONCURRENT_QUEUE ? evalConcurrency() : 1;
    // work() hands over an array because pg-boss can fetch in batches; iterate rather than
    // destructuring the first element, so setting batchSize later cannot silently drop jobs.
    await boss.work(name, { localConcurrency }, async (jobs) => {
      for (const job of jobs) await handler(job.data, { db, boss });
    });
  }

  return {
    boss,
    async stop() {
      await boss.stop({ graceful: true });
      await pool.end();
    },
  };
}

export async function enqueue(
  boss: PgBoss,
  name: string,
  data: object,
  // All queues created by startWorker use the "exclusive" policy: jobs sharing a queue name and
  // singletonKey (including the implicit empty-string key when this is omitted) may not have more
  // than one created/retry/active at a time. Pass a distinct singletonKey per item (e.g. a
  // document or question id) to enqueue multiple jobs on the same queue name concurrently; omit it
  // only when at most one job in flight for that queue name is intended.
  singletonKey?: string,
): Promise<string | null> {
  return boss.send(name, data, singletonKey ? { singletonKey } : {});
}
