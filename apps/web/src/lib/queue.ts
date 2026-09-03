import { PgBoss } from "pg-boss";

// The *promise* is the singleton, not the instance: caching the instance let a second caller
// arriving during start() see a non-null `boss` and send on a connection pool that had not been
// started yet. Concurrent first callers now await the same start.
let bossPromise: Promise<PgBoss> | null = null;
const ensured = new Set<string>();

function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is not set");
      const b = new PgBoss(url);
      await b.start();
      return b;
    })().catch((err: unknown) => {
      bossPromise = null; // a failed start must not poison every later send
      throw err;
    });
  }
  return bossPromise;
}

/** Send-only path. Queues are exclusive-policy (see apps/worker/src/queue.ts): always pass a distinct singletonKey. */
export async function sendJob(queue: string, data: object, singletonKey: string): Promise<void> {
  const b = await getBoss();
  if (!ensured.has(queue)) {
    await b.createQueue(queue, { policy: "exclusive", retryLimit: 3, retryBackoff: true });
    ensured.add(queue);
  }
  await b.send(queue, data, { singletonKey });
}
