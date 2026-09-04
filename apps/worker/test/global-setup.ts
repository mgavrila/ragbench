import { setupTestDatabase } from "@ragbench/db";

/**
 * These tests hit a real database, so create and migrate it before any of them run. Without this
 * the suite only passed when packages/db's tests had already migrated, making
 * `pnpm --filter @ragbench/worker test` fail on a clean database.
 *
 * The default is `ragbench_test`, NOT the compose dev database: this suite runs pg-boss queues, and
 * a `pnpm dev` worker on the same database competes for the very jobs the queue tests wait on.
 */
export default async function setup() {
  await setupTestDatabase(
    process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test",
  );
}
