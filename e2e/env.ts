import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The e2e suite's own database, port and uploads directory -- distinct from both the compose dev
 * database (`ragbench`) and the vitest suites' database (`ragbench_test`), so a Playwright run can
 * never collide with `pnpm dev` or `pnpm test` running alongside it. Deliberately its own env var
 * (`E2E_DATABASE_URL`, not `DATABASE_URL`): falling back to an ambient `DATABASE_URL` would let a
 * shell that already exports one for `pnpm dev` silently point this suite at the dev database.
 */
export const E2E_PORT = 3300;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_e2e";
export const E2E_UPLOADS_DIR = process.env.E2E_UPLOADS_DIR ?? join(tmpdir(), "ragbench-e2e-uploads");
export const E2E_AUTH_SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-suite-secret-not-for-production";

/** Env every server process the suite spawns (web, worker) must agree on. */
export const E2E_SERVER_ENV: Record<string, string> = {
  DATABASE_URL: E2E_DATABASE_URL,
  RAGBENCH_UPLOADS_DIR: E2E_UPLOADS_DIR,
  AUTH_SECRET: E2E_AUTH_SECRET,
};
