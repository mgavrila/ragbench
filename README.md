# RAGBench

RAGBench evaluates RAG configurations side by side — but the wedge is what happens after a run misses: for every missed question, it tells you **why**, deterministically. It re-runs retrieval under counterfactual chunk sets, embedders, and top-k values already in your project, then walks a pure decision table over the evidence — no LLM in the verdict path — to attribute the miss to `chunking`, `embedding`, `retrieval`, or `unanswerable`. An LLM writes a short explanation of the verdict afterward, strictly grounded in the computed evidence; it never gets a vote. A document evidence view shows the gold answer span highlighted against chunk boundaries, so "the answer was split across a boundary" is visible at a glance rather than inferred.

The whole thing runs keyless: sign up, pick the built-in mock LLM and mock embedding model, and generate a test set, run an eval, and diagnose a miss without ever touching a provider API key. Cost is $0 and metered the same way real provider usage would be.

## Features

- **Side-by-side eval runs** — compare chunk set × embedding model × top-k configurations on the same test set: hit@k, MRR, faithfulness, correctness, and cost per config.
- **Deterministic attribution** — every miss is diagnosed by an ordered, pure decision table (`packages/core/src/attribution.ts`), not an LLM guess. The LLM only explains a verdict already computed from measured evidence.
- **Counterfactual matrix** — re-retrieves under alternate chunkers, embedders, and larger top-k values already embedded in the project, and reports pairs it couldn't check as `skipped` rather than guessing.
- **Evidence view** — the source document rendered with the gold span highlighted and chunk boundaries overlaid.
- **Keyless demo mode** — `mock-llm` and `mock-embedding` providers make the whole product usable, end to end, with no API keys and no cost.
- **Char-span gold answers** — test-set questions carry an exact gold answer span, so hit@k is measured by span overlap, not an LLM judging retrieval.

## Quickstart (5 minutes, no API keys)

```bash
git clone <this-repo>
cd ragbench

# 1. Start Postgres (pgvector) only — this compose file does not start the app or worker.
docker compose up -d

# 2. Install and migrate
pnpm install
pnpm db:migrate

# 3. Start the worker (separate terminal)
pnpm --filter @ragbench/worker dev

# 4. Start the web app (separate terminal)
pnpm --filter web dev
```

Open **http://localhost:3000**, sign up (first account, no invite needed), create a project, upload a document, and generate a test set. When picking an LLM and embedding model, choose **mock-llm** and **mock-embedding** — both work with no provider API key and cost nothing. Run an eval, then click **Diagnose** on any missed question to see the verdict and evidence view.

> `pnpm --filter web dev` runs `next dev` (the web app's package is named `@ragbench/web`, but pnpm's `--filter` also matches the unscoped `web`), serving on **port 3000** by default.

## Screenshots

**Run grid** — configs compared side by side, per-question hit/miss cells:

![Run grid: side-by-side config comparison with per-question hit/miss cells](docs/screenshots/run-grid.png)

**Evidence view** — gold span highlighted against chunk boundaries, with the counterfactual matrix and verdict:

![Evidence view: gold answer span highlighted against chunk boundaries, with verdict and counterfactual matrix](docs/screenshots/evidence.png)

## Architecture

```
ragbench/
├── apps/
│   ├── web/            # Next.js app — auth, project/run UI, API routes, enqueues jobs
│   └── worker/          # pg-boss job handlers — parse, chunk, embed, generate-testset,
│                         # start-run, evaluate-question, attribute, reconcile
├── packages/
│   ├── core/            # domain library: chunkers, provider adapters, metrics, attribution
│   │                     # engine, model registry — UI-free and queue-free, unit-testable alone
│   └── db/               # Drizzle schema, migrations, DB client, shared file/usage helpers
├── e2e/                  # Playwright end-to-end suite (demo mode)
└── docs/                 # design spec, screenshots
```

Job pipeline (each stage is a pg-boss queue processed by `apps/worker`):

```mermaid
flowchart LR
    A[Upload document] --> B[parse]
    B --> C[chunk]
    C --> D[embed]
    D --> E[generate-testset]
    E --> F[start-run]
    F --> G[evaluate-question]
    G --> H{Miss?}
    H -->|yes, user clicks Diagnose| I[attribute]
    H -->|no| J[Done]
    I --> K["Counterfactual re-retrieval:\nalt chunker / embedder / top-k"]
    K --> L[Deterministic verdict]
    L --> M[LLM writes explanation]
```

`evaluate-question` is the only queue that runs more than one job at a time (`RAGBENCH_EVAL_CONCURRENCY`, see below); every other queue is serial. A `reconcile` job runs on a 5-minute cron to catch anything left behind by a worker that died mid-job.

## Providers

RAGBench works with **zero provider keys** using the built-in mock LLM and mock embedding model (`mock-llm` / `mock-embedding` in the registry). To use real providers, set the corresponding key — the app reads these directly via each provider's SDK:

| Env var | Provider | Models in the registry |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | `claude-opus-5`, `claude-haiku-4-5` |
| `OPENAI_API_KEY` | OpenAI | `text-embedding-3-small`, `text-embedding-3-large` |
| `GEMINI_API_KEY` | Google (Gemini) | `gemini-2.5-flash`, `gemini-embedding-001` |

Gemini's `gemini-2.5-flash` is the cheapest real LLM in the registry ($0.30 / $2.50 per MTok in/out) and Google's API has a free tier for it — a good option if you want a real (non-mock) LLM without committing to a paid key. `mock-llm` and `mock-embedding` are always $0.

Any key you don't set simply makes its models unavailable in the UI; the rest of the app (including every mock-provider flow) works unaffected.

## Eval concepts

- **Test-set generation** samples passages from a document, asks the LLM to write a question plus a quoted answer span, then verifies that quote against the source text (`verifyQuote` in `packages/core/src/testset.ts`) before accepting it as gold — a question whose "answer" isn't actually found verbatim in the document is discarded rather than trusted.
- **Metrics**: hit@k and reciprocal rank (MRR) are computed purely from char-span overlap between retrieved chunks and the gold span — no LLM judge needed for retrieval quality. Faithfulness and correctness are LLM-judged against the generated answer. Cost is tracked per provider call.
- **Attribution verdict table** (`packages/core/src/attribution.ts`, spec §7.3):

  | Evidence | Verdict |
  |---|---|
  | Gold chunk ranked just outside top-k; a larger k recovers it | `retrieval` |
  | Gold span straddles a chunk boundary, and/or another chunker's set retrieves it | `chunking` |
  | Gold span intact in one chunk, but this embedder doesn't rank it inside top-k, and/or another embedder does | `embedding` |
  | No configuration — original or any counterfactual — retrieves a chunk overlapping the gold span | `unanswerable` |

  See [`docs/superpowers/specs/2026-09-03-ragbench-design.md`](docs/superpowers/specs/2026-09-03-ragbench-design.md) §7 for the full spec.

## Known limitations

- **Sentence chunker terminators are English-centric.** The sentence-window chunker splits on `.`/`!`/`?`; it does not recognize CJK full-width terminators (`。` `！` `？`), so sentence-window chunking on CJK text will under-split. Closing this is tracked for v1.1.
- **Test-set gold spans are first-match.** `verifyQuote` locates a quoted answer by the first occurrence of its normalized text in the document, so on a document that repeats the same phrase, the recorded gold span may not be the occurrence the LLM actually meant. This makes hit@k a conservative lower bound on repetitive documents, not an inflated one.
- **Re-parsing a document invalidates its existing test-set spans.** Gold spans are character offsets into the parsed document text; re-parsing (e.g. re-uploading) shifts or breaks those offsets. Chunk-set staleness after a re-parse is caught by a pre-flight check before you can run against it; the test-set-span half of the same problem is not yet flagged the same way.
- **The counterfactual matrix only covers already-embedded pairs.** Diagnosing against a chunk set × embedder pair that hasn't been embedded yet reports that pair in `skipped` rather than embedding it on the fly. Auto-embedding missing pairs with the cost surfaced first is planned for v1.1.
- **The mock demo generates simple template questions.** `mock-llm` produces deterministic, template-based questions and explanations — good for exercising the full pipeline at zero cost, not representative of real LLM-generated question difficulty or explanation quality.

## Configuration reference

| Env var | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | Prod: yes. Dev: no | dev falls back to `postgres://ragbench:ragbench@localhost:5433/ragbench` | Falls back only outside `NODE_ENV=production`; a production deploy with this unset fails loudly at boot rather than silently reaching for localhost. |
| `AUTH_SECRET` | Prod: yes. Dev: no | none — unset is fine | next-auth v5 only refuses to start without a real secret in production; in dev it runs with no `AUTH_SECRET` set at all (the quickstart above never creates a `.env`). `.env.example` ships a `change-me` placeholder for convenience, not a code-level default. Generate a real one for prod with `openssl rand -hex 32`. |
| `AUTH_TRUST_HOST` | Prod: yes (behind a proxy) | unset | next-auth only trusts the incoming `Host` header when this is set — required whenever the app sits behind a reverse proxy or load balancer. Not needed for `pnpm dev` on localhost. |
| `RAGBENCH_UPLOADS_DIR` | No | `<cwd>/uploads` | Where uploaded documents are stored. The web app writes here and the worker reads from here, so both processes must resolve it to the same directory — set explicitly whenever they run from different working directories (e.g. the prod Docker image sets it to `/app/uploads`). |
| `RAGBENCH_EVAL_CONCURRENCY` | No | `4` | How many `evaluate-question` jobs the worker runs at once, clamped to `1..8`. Every other job queue stays serial regardless of this value. A missing or non-numeric value falls back to the default rather than failing startup. |
| `DISABLE_SIGNUP` | No | unset (signup open) | Set to `1` to 403 the signup route/page — close the door after creating your first account on a single-tenant deployment. Login is never affected. |
| `TEST_DATABASE_URL` | No (test only) | `postgres://ragbench:ragbench@localhost:5433/ragbench_test` | Where `pnpm test` suites write. Created and migrated automatically on first run. |
| `E2E_DATABASE_URL` | No (e2e only) | `postgres://ragbench:ragbench@localhost:5433/ragbench_e2e` | Where `pnpm e2e` (Playwright, demo mode) writes. A third database, separate from the dev and test databases. Created and migrated automatically by `pnpm e2e`. |
| `ANTHROPIC_API_KEY` | No | unset | Enables `claude-opus-5` / `claude-haiku-4-5`. See [Providers](#providers). |
| `OPENAI_API_KEY` | No | unset | Enables `text-embedding-3-small` / `text-embedding-3-large`. See [Providers](#providers). |
| `GEMINI_API_KEY` | No | unset | Enables `gemini-2.5-flash` / `gemini-embedding-001`. See [Providers](#providers). |

See [`.env.example`](.env.example) for the same list with inline comments.

## Production deploy

`docker-compose.prod.yml` builds one image (`Dockerfile`) that runs both the web app and the worker as separate services against a `pgvector/pg16` database. Unlike the dev compose file, it does not publish the database port.

```bash
# .env next to docker-compose.prod.yml (docker compose reads it automatically):
#   POSTGRES_PASSWORD=$(openssl rand -hex 32)
#   AUTH_SECRET=$(openssl rand -hex 32)

docker compose -f docker-compose.prod.yml up -d --build
```

- `AUTH_SECRET` has **no default** in prod — the compose file fails to start without it. Generate with `openssl rand -hex 32`.
- `AUTH_TRUST_HOST=1` is set for you in `docker-compose.prod.yml`, matching a deploy that sits behind a reverse proxy.
- Create your first account at `/signup`, then set `DISABLE_SIGNUP=1` in the compose file's environment and redeploy to close the signup route.
- The worker runs `migrateDb()` in-process on boot, so a fresh database heals itself. A manual migration is still available as an escape hatch: `docker compose -f docker-compose.prod.yml exec worker pnpm db:migrate` — note this is the *first* `pnpm` invocation inside the running container, so it needs outbound network access to fetch the pinned pnpm version via corepack.

## Roadmap (v1.1+)

- Cancel a running eval
- Batch "diagnose all misses" (currently one click per missed question)
- Cost-surfaced counterfactual embedding (embed a missing chunk-set × embedder pair on demand instead of reporting it as `skipped`)
- Query-embedding cache
- Package `dist` builds for `@ragbench/core` / `@ragbench/db` (currently ship TypeScript source directly)
- Worker liveness probe (the Docker healthcheck currently only covers the web app)
- CJK sentence terminators in the sentence-window chunker

RAGBench is open-core in spirit but not in practice yet — everything in this repository is MIT-licensed; there is no separate paid tier today.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, test commands, and PR expectations.

## License

MIT — see [LICENSE](LICENSE).
