import { mkdirSync, rmSync } from "node:fs";
import { setupTestDatabase } from "@ragbench/db";
import { E2E_DATABASE_URL, E2E_UPLOADS_DIR } from "./env";

/**
 * Runs before `playwright test` (see the root `e2e` script), not as Playwright's own globalSetup:
 * Playwright starts every `webServer` entry as part of its own bootstrap BEFORE globalSetup runs
 * (webServer is registered as a plugin, and plugin setup tasks precede the user's globalSetup file
 * in the runner's task list), so a globalSetup that creates the database would race the web/worker
 * processes it is supposed to prepare the database for. Running this as a separate step ahead of
 * `playwright test` sidesteps that ordering entirely.
 *
 * Mirrors apps/web/test/global-setup.ts and apps/worker/test/global-setup.ts's create-if-absent
 * pattern, against the suite's own `ragbench_e2e` database instead of `ragbench_test`.
 */
async function main(): Promise<void> {
  await setupTestDatabase(E2E_DATABASE_URL);
  // Wiped rather than reused: a stale upload from a previous local run sits under a document id
  // that no longer exists in the freshly-migrated database, so it can only ever be dead weight.
  rmSync(E2E_UPLOADS_DIR, { recursive: true, force: true });
  mkdirSync(E2E_UPLOADS_DIR, { recursive: true });
  console.log(`e2e: database ready at ${E2E_DATABASE_URL}`);
  console.log(`e2e: uploads dir ready at ${E2E_UPLOADS_DIR}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
