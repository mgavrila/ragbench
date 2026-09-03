# RAGBench — Design Spec

**Date:** 2026-09-03
**Status:** Approved design, pending implementation plan
**One-line pitch:** Upload your docs, and RAGBench auto-generates a test set, runs your retrieval configs side by side, and — when a config misses a question — tells you *which stage* caused the miss: chunking, embedding, or retrieval.

## 1. Product definition

### What it is

A self-hosted, open-source full-stack application (frontend + backend + LLM) for evaluating and diagnosing RAG retrieval pipelines. Every existing tool in this space reports scores; RAGBench's differentiator is **per-miss failure attribution** — counterfactually re-running a missed question with one pipeline stage swapped at a time to determine whether the miss was a chunking, embedding, or retrieval failure, with highlighted document evidence.

### Target user

The TypeScript/Next.js developer building RAG into a product who is currently tuning chunk sizes by intuition. The serious eval tools (Ragas, AutoRAG, Phoenix, DeepEval) are all Python; this ecosystem has no incumbent.

### Strategy

- **Traction first:** free, genuinely complete self-hosted app; `docker compose up` is the whole install story. Launch asset: a 60-second video of RAGBench diagnosing a chunking bug.
- **Monetization second (open-core):** MIT-licensed core with a commercially-licensed `ee/` directory added later (SSO, RBAC, audit logs, regression CI with alerting) plus an eventual hosted cloud. V1 ships no paid features but does not block them: org-scoped tenancy, minimal auth, and per-call usage metering go in from day one.

### V1 core loop

1. Upload PDFs/Markdown → corpus ingested, chunked under multiple strategies.
2. LLM generates an extractive test set from the corpus (questions + gold answers + verified source spans).
3. User picks 2–3 configs (chunker × embedding model × top-k) and runs the eval.
4. Dashboard: hit@k, MRR, faithfulness, correctness, and cost per config, side by side.
5. Click any miss → attribution engine reports e.g. "chunking failure — the answer was split across a heading boundary," with the chunks and gold span highlighted in the source document.

### Explicitly deferred (see §10)

Regression tracking, hybrid/BM25/rerankers, semantic chunking, more ingest formats, deployable chat endpoint, plugin system, ANN indexes, cloud/billing.

## 2. System architecture

Single monorepo (`ragbench`, pnpm workspaces), three packages:

- **`apps/web`** — Next.js (App Router). Serves the dashboard UI and the HTTP API via route handlers. No separate API server in v1.
- **`apps/worker`** — Node/TS process consuming jobs from a Postgres-backed queue (**pg-boss**). All slow work lives here: parsing, chunking, embedding, test-set generation, eval runs, attribution. Long jobs must survive page reloads, hence out of Next.js.
- **`packages/core`** — the domain library both apps import: chunkers, provider adapters, metrics, attribution engine. UI-free and queue-free; unit-testable in isolation; publishable as an npm package later at zero extra cost.

**Data layer:** one Postgres with pgvector, via Drizzle ORM. Postgres is also the job queue — no Redis. `docker compose up` runs exactly two containers: `app` (web + worker, one image, two processes) and `postgres`. Uploaded files live on a Docker volume, not S3.

**LLM/embeddings:** thin provider adapter in `core`. Launch providers: Anthropic (generation, judging, attribution explanations) and OpenAI (embeddings). Users bring their own keys via env vars; the settings screen shows key status but keys are never stored in the DB. A deterministic **mock provider** ships alongside (see §9) and doubles as a no-keys demo mode.

**Realtime progress:** worker writes progress to DB; UI polls the run-status row with SWR every 2s during active runs. No WebSockets in v1.

**Judgment calls:** no separate API server, no Redis, no WebSockets, no S3 — each cut keeps the install at two containers and removes an operational failure mode at no cost to the v1 feature set.

## 3. Data model

Postgres, ~13 tables. Key normalization decision: **a config is decomposed into its stages** (chunking → embedding → retrieval) so configs differing in one stage share the other stages' work — this is what makes counterfactual attribution affordable.

### Tenancy (monetization-proofing)

- `organizations` — top-level tenant. Self-host first-run creates one.
- `users` — Auth.js email/password credentials; belongs to an organization.
- `usage_log` — one row per LLM/embedding API call: org, purpose, model, tokens, computed cost. Powers the self-hoster's "this run cost $0.42" display and the future cloud's billing meter.

### Corpus side

- `projects` — scope for everything below; belongs to an organization.
- `documents` — filename, mime, parsed plain text, content hash, status (`parsing | ready | failed`) with user-visible failure reason.
- `chunk_sets` — one per (project × chunker strategy × params). Chunking depends only on the chunker, so configs sharing a chunker share a chunk set.
- `chunks` — belongs to a chunk set; text, source document id, **char offsets into the document** (powers boundary-split evidence).
- `chunk_embeddings` — one per (chunk × embedding model); pgvector column + model name + dimension. Configs sharing chunker and embedder share embeddings.

### Eval side

- `rag_configs` — named triple: chunk_set + embedding model + top-k. The unit users compare.
- `test_sets` — belongs to a project; records generation model/prompt for reproducibility.
- `test_questions` — question, gold answer, source document id, **gold char-span** in source text, status (active/deleted by review).
- `eval_runs` — test set × set of configs; mode (`full | retrieval-only`); judge model pinned; status + progress counters (`completed_jobs / total_jobs`).
- `question_results` — one per (run × config × question): retrieved chunk ids with ranks and similarity scores, hit@k, reciprocal rank, generated answer, faithfulness score, correctness score, raw judge output, or `failed` + error.
- `attributions` — one per investigated miss: counterfactual results table, verdict (`chunking | embedding | retrieval | unanswerable`), LLM-written explanation, evidence chunk ids.

pg-boss manages its own job tables in a separate schema; job state never mixes with domain state.

### Judgment calls

1. **No ANN index in v1.** Typed-dimension pgvector indexes fight multi-model support in one table. V1 corpora are thousands of chunks; exact KNN scan is milliseconds. Column stays dimension-untyped and unindexed; indexing is a v2 concern.
2. **Gold answers are char-spans, not just text.** Makes hit@k objective (span overlap, no judge needed for retrieval metrics) and powers the attribution evidence view. Constrains v1 to extractive questions; multi-hop/abstractive is v2.
3. **Config-level metrics aggregated on read**, never stored — no denormalized-counter drift; the aggregation over ≤hundreds of rows is trivial.

## 4. Ingestion pipeline

1. **Upload.** Web accepts PDF and Markdown/plain text (drag-and-drop, multiple files) → Docker volume → one `parse` job per document. Other formats deferred.
2. **Parse.** Worker extracts plain text (`unpdf` for PDF; passthrough for Markdown), stores text + content hash. Parse failure marks that document `failed` with a reason; the rest of the corpus proceeds.
3. **Chunk.** Three v1 chunkers, chosen because they fail differently (which makes attribution demos interesting):
   - **fixed-size** — N tokens with overlap; the naive baseline that splits answers mid-sentence.
   - **heading-based** — splits on Markdown headings / PDF outline; fails on oversized sections.
   - **sentence-window** — sentence boundaries with neighbor context.
   Each is a pure function in `packages/core`: document text → chunks with char offsets. Semantic chunking deferred (needs embeddings during chunking; tangles the stages we keep attributable).
4. **Embed.** Missing (chunk_set × embedding model) pairs trigger `embed` jobs: batched API calls, retry with backoff, rate-limit aware; writes `chunk_embeddings` + `usage_log`. Content-hash checks make re-ingesting unchanged documents a no-op.

All jobs are idempotent (keyed on content hashes and entity ids), retried 3× with backoff; terminal failures surface on the owning entity's status.

## 5. Test-set generation

For each document the worker samples passages spread across the document and prompts the LLM for extractive Q&A pairs: a natural question, the answer, and **the verbatim source quote**.

**The load-bearing trick:** the pipeline programmatically verifies the quote exists in the document text (whitespace-normalized string search) and stores its char-span as ground truth. An LLM asked for offsets hallucinates; an LLM asked for an exact quote can be checked mechanically. Pairs whose quotes don't match are dropped and logged, not repaired.

**Quality gates:**
- A cheap LLM pass filters trivially string-matchable questions (question quotes the answer's unique phrasing verbatim — these score 100% under every config and teach nothing).
- A review screen lets the user delete bad questions before the first run.

**Cost controls:** default 30 questions per corpus, configurable; a cost estimate is shown *before* generation runs.

## 6. Eval run engine

**Orchestration.** Starting a run creates the `eval_runs` row, ensures prerequisites (queueing missing `embed` jobs first), then fans out one `evaluate-question` job per (config × question) — 3 configs × 30 questions = 90 small jobs. A crash loses one question, not the run; per-job retries come free from pg-boss; progress = completed/total. Worker caps LLM concurrency (default 4, configurable).

**Per-question job:**
1. **Retrieve.** Embed the question with the config's embedder (cached per test-set × model), exact KNN over the config's chunk embeddings, take top-k. Store chunk ids, ranks, similarity scores.
2. **Score retrieval — no LLM.** Hit iff a retrieved chunk's char-span overlaps the gold span. Compute hit@k and reciprocal rank in pure TS in `packages/core`.
3. **Generate + judge** (full mode only). LLM answers from retrieved chunks only; a judge call scores **faithfulness** (every claim supported by retrieved chunks?) and **correctness** (matches gold answer?), each 0–1 with a one-line justification, stored raw.

**Judgment calls:**
1. Judge scores are graded 0–1, not pass/fail; the judge model is pinned per run. Cross-run comparisons with different judges get a UI warning, not a hard block.
2. **Retrieval-only mode** computes hit@k/MRR at ~10× lower cost (zero generation/judging) — the daily driver while tuning chunking. Full mode is the default.

**Failure handling:** a question job that exhausts retries records a `failed` result row; the run completes with "27/30 scored, 3 failed" rather than hanging. Runs are cancellable (pg-boss cancellation + status check between steps).

## 7. Attribution engine (the wedge)

Triggered per-miss ("Diagnose" button on a missed question) or batch ("Diagnose all misses"). Not automatic on every miss — the user sees a cost/scope note first when new embeddings would be required.

Given a miss under config C = (chunk_set S, embedder E, top-k K) for question q:

### 7.1 Deterministic signals (no LLM, no new API calls)

- **Boundary check:** is the gold span fully contained in a single chunk of S? If it straddles chunk boundaries → chunking-split evidence.
- **Rank check:** rank of the best gold-overlapping chunk in the full KNN ordering. In-corpus but rank > K → ranking near-miss; uniformly low similarity → semantic-gap evidence.

### 7.2 Counterfactual matrix (retrieval-only re-runs, cheap)

- **Swap chunker:** re-retrieve with each other chunk_set S′ (same E, same K). Requires S′×E embeddings — reused if they exist, else queued with cost surfaced.
- **Swap embedder:** re-retrieve with S under each other available embedder E′.
- **Swap top-k:** re-check at 2K and 4K — distinguishes "ranked just outside" from "not findable at all."

Each cell of the matrix is a hit/miss plus rank — retrieval-only, so cells cost microseconds when embeddings exist.

### 7.3 Verdict — deterministic decision table

| Evidence | Verdict |
|---|---|
| Gold span split across boundary in S, and/or another chunker hits with same E | `chunking` |
| Gold span intact in one chunk; another embedder hits with same S; rank far under E | `embedding` |
| Gold chunk ranked just outside K; raising K hits | `retrieval` |
| No config combination hits | `unanswerable` — question flagged as a test-set issue |

Rules are ordered and pure functions in `packages/core`, table-driven-testable. **The LLM never decides the verdict.**

### 7.4 LLM explanation

Given the computed evidence bundle, the LLM writes a 2–3 sentence human explanation strictly grounded in that evidence (it explains; it does not diagnose). Stored in `attributions` with the counterfactual table and evidence chunk ids.

### 7.5 Evidence UI (the money shot)

The source document rendered with the gold span highlighted and chunk boundaries overlaid — making "the answer was split across a boundary" visible at a glance — plus the counterfactual matrix and verdict badge.

## 8. API surface and UI

### API

Next.js route handlers under `/api`, JSON, Zod-validated (schemas shared with the frontend). Resources: `organizations/auth` (Auth.js), `projects`, `documents` (upload + status), `chunk-sets`, `configs`, `test-sets` (generate / review / delete questions), `runs` (create / status / results / cancel), `attributions` (diagnose), `settings` (provider key status), `usage`.

### UI flows (Next.js App Router, Tailwind)

- **First run:** create user + org → create project → guided to upload.
- **Corpus page:** drag-and-drop upload, per-document status, parse-failure reasons.
- **Test set page:** generate (with pre-flight cost estimate), review grid, delete questions.
- **Configs page:** build configs by picking chunker (+params), embedding model, top-k.
- **New run:** pick configs + mode (full / retrieval-only), pre-flight cost estimate.
- **Run detail (core screen):** config columns side by side — metric summary row (hit@k, MRR, faithfulness, correctness, cost), then a per-question grid of hit/miss cells. Clicking a cell opens a drawer: retrieved chunks with scores, generated answer, judge output, **Diagnose** button.
- **Attribution view:** verdict badge, counterfactual matrix, document evidence view (§7.5).
- **Settings:** provider key status, usage/cost log.

Visual direction: cool neutral palette, single sans-serif, color reserved for state (hit/miss/verdict). Dashboard aesthetic, not decorative.

## 9. Providers, errors, and the mock provider

- `EmbeddingProvider` and `LLMProvider` interfaces in `core`; a model registry carries dimensions and per-token prices (powers cost estimates and `usage_log`).
- Launch implementations: Anthropic (LLM), OpenAI (embeddings).
- **Mock provider:** deterministic hash-based embeddings and canned generation. Serves CI (no API calls, no keys) and doubles as **demo mode** — a stranger can run the full loop with zero API keys, which materially helps traction.
- Typed error taxonomy (rate-limit, auth, transient, fatal); retries with backoff on transient; everything user-facing surfaces on entity status fields with a human-readable reason — nothing dies silently in the queue.

## 10. Testing strategy

- **`packages/core`:** pure unit tests — chunkers against fixture documents (boundary cases: huge sections, no headings, unicode), metrics against hand-computed fixtures, the attribution decision table exercised row by row (table-driven).
- **Worker pipelines:** integration tests against a real Postgres (Docker) with the mock provider — ingest → generate → run → attribute, asserting DB state at each stage.
- **E2E:** Playwright smoke over the golden path (upload → generate → run → diagnose) in demo mode.
- **CI:** GitHub Actions — typecheck, lint, unit, integration on every PR.

## 11. Deferred (v2+ vision)

- **Regression tracking / CI gate** (pin a baseline config, fail on drift; corpus-diff-aware re-runs) — the flagship `ee/`-candidate feature.
- Hybrid retrieval: BM25, fusion, rerankers.
- Semantic chunking.
- More ingest sources: HTML, Notion/Confluence exports, web crawl.
- Deployable chat endpoint ("promote the winning config to an API").
- Plugin system (community embedders, vector stores, data sources).
- ANN indexes for large corpora.
- Hosted cloud + billing (usage metering already in place).
- `ee/` directory with commercial license (SSO, RBAC, audit logs).

## 12. Stack summary

pnpm monorepo · TypeScript strict · Next.js (App Router) · Tailwind · Drizzle ORM · Postgres + pgvector · pg-boss · Auth.js · unpdf · Zod · Vitest + Playwright · Docker Compose (2 containers) · MIT license (core).
