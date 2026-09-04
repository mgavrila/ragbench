import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "url";
import path from "path";
import * as schema from "./schema";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * `poolMax` is the pg Pool's connection cap. It is optional and defaults to node-postgres's own
 * default (10) so the web app is unaffected: a Next.js route handler holds a connection for the
 * length of one request. The worker passes an explicit value instead, because it runs several
 * evaluate-question jobs at once and each one holds a connection across provider round trips --
 * with the default cap, jobs beyond the tenth queue up waiting for a connection rather than for the
 * provider, and the concurrency knob stops meaning anything. See apps/worker/src/queue.ts.
 */
export function createDb(url: string, opts: { poolMax?: number } = {}) {
  const pool = new pg.Pool({ connectionString: url, ...(opts.poolMax ? { max: opts.poolMax } : {}) });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function migrateDb(url: string) {
  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

export type Db = ReturnType<typeof createDb>["db"];
