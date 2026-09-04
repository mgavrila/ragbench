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
/**
 * Upper bound on the knob. Past a handful of jobs the limit stops being this process and starts
 * being the provider's rate limit, which answers extra concurrency with 429s -- retries and a
 * slower run, not a faster one. Each in-flight job also holds a database connection for the length
 * of its provider round trips, so an unbounded value here silently sizes the connection pool too.
 * A user who sets 100 gets 8 rather than a startup failure: this is a throughput knob.
 */
const MAX_EVAL_CONCURRENCY = 8;

function evalConcurrency(): number {
  const parsed = Number.parseInt(process.env.RAGBENCH_EVAL_CONCURRENCY ?? "", 10);
  // A missing, non-numeric or nonsensical value falls back to the default rather than failing
  // startup: the cap is a throughput knob, and a typo in it should not take the worker down.
  if (!Number.isFinite(parsed)) return DEFAULT_EVAL_CONCURRENCY;
  return Math.min(MAX_EVAL_CONCURRENCY, Math.max(1, parsed));
}

export async function startWorker(opts: {
  databaseUrl: string;
  handlers: Record<string, JobHandler<any>>;
  // Cron schedules to register once every named queue exists. pg-boss's `schedule` table has a
  // foreign key on queue name (see its plans.js), so a schedule for a queue not yet created throws
  // "Queue X not found". Registering these after the createQueue loop below guarantees that queue
  // already exists PROVIDED its name is also a key in `handlers` above -- the only thing this
  // function itself creates queues for. A schedule naming a queue this call never registers still
  // fails with pg-boss's own "Queue not found", regardless of the order these two loops run in.
  schedules?: Array<{ name: string; cron: string }>;
}) {
  const boss = new PgBoss(opts.databaseUrl);
  // Without a listener, pg-boss's own EventEmitter throws synchronously on an unhandled "error"
  // event (Node's default for EventEmitter) and takes the whole worker process down with it. The
  // cron/maintenance loop this module relies on (createQueue's internal housekeeping, schedule()'s
  // own tick supervisor) emits these on things like a transient connection drop -- exactly the kind
  // of failure that should be logged and left to retry on its own, not crash the process.
  boss.on("error", (err) => console.error("pg-boss error", err));
  // Sized for the fan-out: every concurrent evaluate-question job holds a connection for the whole
  // job (it queries around its provider calls, not only before them), so a pool smaller than the
  // concurrency makes jobs wait on connections instead of on the provider. The headroom covers the
  // handlers' own extra queries and the serial queues running alongside; the floor keeps the
  // default configuration at node-postgres's usual 10 rather than shrinking it.
  const concurrency = evalConcurrency();
  const { db, pool } = createDb(opts.databaseUrl, { poolMax: Math.max(10, concurrency + 6) });
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
    const localConcurrency = name === CONCURRENT_QUEUE ? concurrency : 1;
    // work() hands over an array because pg-boss can fetch in batches; iterate rather than
    // destructuring the first element, so setting batchSize later cannot silently drop jobs.
    await boss.work(name, { localConcurrency }, async (jobs) => {
      for (const job of jobs) await handler(job.data, { db, boss });
    });
  }

  // No singletonKey: the target queue's "exclusive" policy above then keys on the implicit
  // empty-string key, so a tick whose previous job is still created/retrying/active is dropped
  // rather than queued -- at most one reconcile job in flight at a time, which is what lets it be
  // safely idempotent instead of needing its own overlap guard.
  for (const { name, cron } of opts.schedules ?? []) {
    await boss.schedule(name, cron);
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
