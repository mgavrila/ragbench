# Contributing to RAGBench

## Dev setup

```bash
git clone <this-repo>
cd ragbench

docker compose up -d      # Postgres (pgvector) only, published on localhost:5433
pnpm install
pnpm db:migrate
```

Run the app in two terminals:

```bash
pnpm --filter @ragbench/worker dev   # pg-boss job handlers, watches for changes
pnpm --filter web dev                # Next.js app on http://localhost:3000
```

Sign up, create a project, and pick `mock-llm` / `mock-embedding` to exercise the full pipeline with no provider API keys. See the [README quickstart](README.md#quickstart-5-minutes-no-api-keys) for more detail.

## Tests

```bash
pnpm test        # every workspace package's vitest suite
pnpm typecheck    # every workspace package's tsc, plus e2e/tsconfig.json
pnpm e2e          # Playwright, demo mode (mock providers only)
```

`pnpm test` and `pnpm e2e` each use their own database (`TEST_DATABASE_URL`, default `ragbench_test`; `E2E_DATABASE_URL`, default `ragbench_e2e`), separate from the dev database and from each other. Both are created and migrated automatically the first time you run the corresponding command — no manual setup needed.

You do not need to stop a `pnpm --filter @ragbench/worker dev` process before running `pnpm test` or `pnpm e2e`: each suite creates and migrates its own database (`ragbench_test` / `ragbench_e2e`) on first run, distinct from the dev database the worker polls, so the worker can keep running while tests execute.

Two exceptions, both about the **web** dev server and stray workers:

- **Stop `pnpm --filter web dev` before `pnpm e2e`.** The e2e suite starts its own web server from the same app directory, and Next refuses a second dev instance of the same app — the run fails with a terse `Process from config.webServer was not able to start. Exit code: 1`.
- **A worker started with a custom `DATABASE_URL` or `RAGBENCH_UPLOADS_DIR` can silently steal e2e jobs.** If you ever point a dev worker at `ragbench_e2e` (or at a Postgres on the same port as the e2e one), kill it before running `pnpm e2e` — pg-boss delivers each job to whichever worker polls first, and a worker with a different uploads directory fails parse jobs with `ENOENT`.

## Pull requests

- Use [conventional commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Add or update tests for any behavior change — `packages/core` favors table-driven unit tests (see `packages/core/test`), `apps/web`/`apps/worker` test against a real database via each package's `test/global-setup.ts`.
- Run `pnpm typecheck` and `pnpm test` locally before opening a PR; CI (`.github/workflows/ci.yml`) runs both plus the Playwright e2e suite.
- Keep PRs scoped to one change — smaller diffs review faster and bisect cleaner.
