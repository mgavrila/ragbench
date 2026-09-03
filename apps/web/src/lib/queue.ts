import { PgBoss } from "pg-boss";

let boss: PgBoss | null = null;
const ensured = new Set<string>();

async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    boss = new PgBoss(url);
    await boss.start();
  }
  return boss;
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
