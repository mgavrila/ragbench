import { PgBoss } from "pg-boss";
import { createDb, type Db } from "@ragbench/db";

export type JobHandler<T> = (data: T, ctx: { db: Db }) => Promise<void>;

export async function startWorker(opts: {
  databaseUrl: string;
  handlers: Record<string, JobHandler<any>>;
}) {
  const boss = new PgBoss(opts.databaseUrl);
  const { db, pool } = createDb(opts.databaseUrl);
  await boss.start();

  for (const [name, handler] of Object.entries(opts.handlers)) {
    await boss.createQueue(name, { retryLimit: 3, retryBackoff: true, policy: "exclusive" });
    await boss.work(name, async ([job]) => {
      await handler(job.data, { db });
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
  singletonKey?: string,
): Promise<string | null> {
  return boss.send(name, data, singletonKey ? { singletonKey } : {});
}
