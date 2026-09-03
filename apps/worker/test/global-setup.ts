import { migrateDb } from "@ragbench/db";

/**
 * These tests hit a real database, so migrate before any of them run. Without this the suite
 * only passed when packages/db's tests had already migrated, making
 * `pnpm --filter @ragbench/worker test` fail on a clean database.
 */
export default async function setup() {
  await migrateDb(
    process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench",
  );
}
