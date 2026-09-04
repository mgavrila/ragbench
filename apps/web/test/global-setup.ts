import { setupTestDatabase } from "@ragbench/db";

/**
 * These tests hit a real database, so create and migrate it before any of them run. Without this
 * the suite only passed when packages/db's tests had already migrated, making
 * `pnpm --filter @ragbench/web test` fail on a clean database.
 *
 * The default is `ragbench_test`, NOT the compose dev database: these suites insert orgs, projects
 * and runs on every pass, and doing that in the database the dev app is using made both harder to
 * read (see apps/worker/test/global-setup.ts for the queue side of the same separation).
 */
export default async function setup() {
  await setupTestDatabase(
    process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test",
  );
}
