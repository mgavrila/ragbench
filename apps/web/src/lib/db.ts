import { createDb, type Db } from "@ragbench/db";

let cached: { db: Db } | null = null;

/**
 * Dev convenience, matching apps/worker/src/main.ts: an unset DATABASE_URL falls back to the
 * compose connection string rather than throwing, so `pnpm dev` works on a fresh checkout with no
 * .env at all. Gated to non-production so a real deployment with a missing DATABASE_URL throws
 * loudly at first use instead of silently connecting to localhost:5433 -- in production that port
 * is either nothing (connection refused) or someone else's database.
 */
const DEFAULT_DATABASE_URL =
  process.env.NODE_ENV !== "production" ? "postgres://ragbench:ragbench@localhost:5433/ragbench" : undefined;

export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (see .env.example for the compose default)");
    cached = { db: createDb(url).db };
  }
  return cached.db;
}
