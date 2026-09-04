import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT, E2E_SERVER_ENV } from "./e2e/env";

/**
 * Demo-mode end-to-end suite: one serial spec drives the whole keyless pipeline (signup through a
 * diagnosed evidence page) against real web + worker processes and a real Postgres, using only the
 * `mock-*` providers so it needs no API key and spends nothing.
 *
 * `E2E_DATABASE_URL`/uploads dir are prepared by `e2e/prepare-db.ts` (run by the root `e2e` script
 * BEFORE this config is even loaded) rather than by Playwright's own `globalSetup`: `globalSetup`
 * runs AFTER the `webServer` entries below have already started (webServer is a runner plugin, and
 * plugin setup precedes globalSetup in the task list), so a globalSetup-based database creation
 * would race the very processes it is meant to prepare the database for.
 */
export default defineConfig({
  testDir: "./e2e",
  // The spec is one long story with several sequential worker-backed waits (document parse, chunk
  // embedding, test-set generation, the run itself), each individually bounded at 30-90s per the
  // house's polling convention -- their sum needs a much larger ceiling than any single wait, even
  // though the happy path finishes in a small fraction of it.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Both the web app and the worker run for the duration of the whole suite. The worker has no
  // HTTP port to poll, so its readiness is a `wait.stdout` regex match against the exact line
  // apps/worker/src/main.ts logs once migrations have applied and the queue has started -- the
  // controller's fallback of a globalSetup-spawned child process is not needed since Playwright's
  // webServer array supports a command with no `port`/`url` at all as long as `wait` is given.
  webServer: [
    {
      name: "worker",
      command: "pnpm --filter @ragbench/worker exec tsx src/main.ts",
      env: E2E_SERVER_ENV,
      wait: { stdout: /ragbench worker started/ },
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "web",
      command: "pnpm --filter @ragbench/web dev",
      env: { ...E2E_SERVER_ENV, PORT: String(E2E_PORT) },
      url: `${E2E_BASE_URL}/login`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
