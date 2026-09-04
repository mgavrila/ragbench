import { createDb, type Db } from "@ragbench/db";

let cached: { db: Db } | null = null;

/**
 * Dev convenience, matching apps/worker/src/main.ts: an unset DATABASE_URL falls back to the
 * compose connection string rather than throwing, so `pnpm dev` works on a fresh checkout with no
 * .env at all. Production compose (and any real deployment) sets DATABASE_URL explicitly, so this
 * default never decides where a deployed app writes -- it only keeps the two processes from
 * disagreeing about the local default.
 */
const DEFAULT_DATABASE_URL = "postgres://ragbench:ragbench@localhost:5433/ragbench";

export function getDb(): Db {
  if (!cached) {
    cached = { db: createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL).db };
  }
  return cached.db;
}
