import { migrateDb } from "./client";

/**
 * Dev convenience, matching apps/web/src/lib/db.ts and apps/worker/src/main.ts: an unset
 * DATABASE_URL falls back to the compose connection string rather than failing, so `pnpm
 * db:migrate` works on a fresh checkout with no .env at all. Gated to non-production so a real
 * deployment with a missing DATABASE_URL fails loudly instead of silently migrating
 * localhost:5433 -- in production that port is either nothing (connection refused) or someone
 * else's database.
 */
const DEFAULT_DATABASE_URL =
  process.env.NODE_ENV !== "production" ? "postgres://ragbench:ragbench@localhost:5433/ragbench" : undefined;

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example for the compose default)");
  process.exit(1);
}

await migrateDb(url);
console.log("migrations applied");
