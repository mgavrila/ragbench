import { setupTestDatabase } from "../src/testing";

/**
 * Same test-database separation as the app suites (apps/worker/test/global-setup.ts): these tests
 * exercise the schema against a real Postgres, and they now do it in `ragbench_test` rather than
 * the compose dev database. Creating and migrating it here is what lets this package's tests run
 * first on a clean checkout without a manual `pnpm db:migrate`.
 */
export default async function setup() {
  await setupTestDatabase(
    process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test",
  );
}
