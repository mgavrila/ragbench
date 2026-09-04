# RAGBench Attribution Implementation Plan (Plan 5 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wedge: click Diagnose on a missed question and get a deterministic verdict — chunking, embedding, retrieval, or unanswerable — backed by a counterfactual matrix and a document evidence view with the gold span highlighted against chunk boundaries.

**Architecture:** An `attribute` worker job computes deterministic signals (is the gold span contained in a single chunk of this config's set? what rank does the best gold-overlapping chunk get in the full KNN ordering?), runs a counterfactual matrix of retrieval-only re-runs over EXISTING (chunk_set × embedding model) pairs in the project (no new embedding spend in v1 — missing pairs are reported as "not embedded", never auto-embedded) plus top-k sweeps at 2K/4K, then applies the spec's ordered decision table (pure core function; the LLM only writes the explanation — mock model yields a deterministic template). Evidence UI renders the source document with `<mark>` on the gold span and visible chunk-boundary ticks.

**Spec:** `docs/superpowers/specs/2026-09-03-ragbench-design.md` §7 (all subsections; §7.2's "queued with cost surfaced" simplified per ruling: v1 reports missing pairs instead of embedding them).

## Global Constraints

- All prior conventions hold (5433, singleton keys, idempotent handlers, factories+reporter with purpose `"attribution"`, Object.hasOwn, org-chain scoping, strict TS, conventional commits no trailer).
- The verdict is NEVER decided by the LLM (spec §7.3/7.4). Mock explanation path keeps the whole flow keyless.
- Counterfactual retrievals reuse `retrieveTopK` and `evaluateRetrieval` — no duplicate retrieval logic.

---

### Task 1: Verdict engine (core, pure)

**Files:** Create `packages/core/src/attribution.ts`; modify `packages/core/src/index.ts`; test `packages/core/test/attribution.test.ts`.

**Interfaces:**
- `type AttributionSignals = { goldInSingleChunk: boolean; bestGoldRank: number | null; k: number }` (bestGoldRank 1-based over the FULL ordering; null = no gold-overlapping chunk exists in the set).
- `type Counterfactual = { kind: "chunker" | "embedder" | "topk"; label: string; hit: boolean; rank: number | null }`.
- `decideVerdict(signals, counterfactuals): { verdict: "chunking" | "embedding" | "retrieval" | "unanswerable"; rule: string }` — ordered rules exactly per spec §7.3:
  1. `retrieval` when bestGoldRank !== null && bestGoldRank > k && any topk counterfactual hit.
  2. `chunking` when !goldInSingleChunk, OR any chunker counterfactual hit (while the original missed).
  3. `embedding` when goldInSingleChunk && (any embedder counterfactual hit OR bestGoldRank === null OR bestGoldRank > k).
  4. `unanswerable` when nothing hits anywhere (no counterfactual hit and bestGoldRank null).
  Precedence exactly in that order; `rule` names the matched rule for auditability. (Rule 1 outranks 2: a near-miss fixable by raising k is a retrieval failure even if the span also straddles chunks.)
- `buildExplanationPrompt(question, verdict, signals, counterfactuals): string` — asks for 2–3 sentences STRICTLY grounded in the provided evidence; `mockExplanation(verdict, signals): string` deterministic template.
- [ ] Steps: table-driven TDD covering every rule + precedence collisions (topk-hit + straddling → retrieval; straddle + chunker-hit → chunking; intact + nothing hits → unanswerable; intact + embedder hit → embedding) → implement → green → commit `feat: deterministic attribution verdict engine`.

---

### Task 2: attribute job (worker)

**Files:** Create `apps/worker/src/handlers/attribute.ts`; modify `apps/worker/src/main.ts`; test `apps/worker/test/attribute.test.ts`.

**Interfaces:**
- `attributeHandler: JobHandler<{ resultId: string; organizationId: string }>`:
  1. Existing attribution for resultId → no-op. Load result→question→config→run chain (missing → no-op). Works on ANY result (hit or miss — UI offers Diagnose on misses, but the handler doesn't care).
  2. Signals: gold-in-single-chunk via SQL over the config set's chunks for the gold document; bestGoldRank via full retrieval ordering (retrieveTopK with k = count of set's chunks, or a rank query) — re-embed the question via the config's embedder (purpose "attribution"; mock path keyless).
  3. Counterfactuals over existing data only: for every OTHER chunk_set in the project that HAS embeddings for the config's model → chunker counterfactual (label = chunker name+params); for every OTHER embedding model with embeddings on the config's chunk_set → embedder counterfactual (label = model; question embedded with THAT model); topk at 2K and 4K (labels "k=2K"/"k=4K" with actual numbers). Each = retrieveTopK + evaluateRetrieval. Missing pairs: record `{ kind, label, hit: null }`? NO — spec'd shape has hit boolean; missing pairs are simply omitted from the matrix and listed in a `skipped: string[]` array persisted inside the counterfactuals jsonb (shape: `{ matrix: Counterfactual[], skipped: string[] }`).
  4. `decideVerdict`; explanation via run.judgeModel (mock-llm → mockExplanation); insert attributions row (evidenceChunkIds = gold-overlapping chunk ids + the retrieved-at-k ids).
  5. Failure classes: non-retryable ProviderError → attributions row with verdict from deterministic signals anyway?? NO — simpler and honest: explanation is optional; wrap ONLY the explanation call gate-style (fail-open: explanation null on ProviderError, verdict still stored). Query-embedding failure: non-retryable → no row + rethrow? It would burn retries and vanish. Ruling: treat like generation — non-retryable embed failure inserts NOTHING and does not throw, but there's no status field... v1: log to console.error and resolve (the UI's diagnose button can be clicked again); document in code. Retryable → throw.
- [ ] Steps: TDD keyless (seed two chunk sets [fixed straddling / heading intact] + mock embeddings via real handlers; craft texts so hashEmbed ranks predictably): (a) straddle case → verdict chunking with chunker counterfactual hit; (b) intact-but-unranked → embedding; (c) near-miss fixed at 2K → retrieval; (d) nothing hits → unanswerable; (e) idempotent re-run; (f) explanation present (mock template) → implement → green + full suite → commit `feat: attribute job with counterfactual matrix over existing embeddings`.

---

### Task 3: Diagnose API + attribution UI (the money shot)

**Files:** Create `apps/web/src/app/api/results/[resultId]/diagnose/route.ts`, `apps/web/src/app/api/results/[resultId]/attribution/route.ts`, `apps/web/src/app/results/[resultId]/page.tsx`, `apps/web/src/app/results/[resultId]/evidence-client.tsx`; modify `apps/web/src/app/runs/[runId]/run-client.tsx` (Diagnose button + link in the cell drawer).
Test: `apps/web/test/attribution-api.test.ts`.

**Interfaces:**
- POST diagnose: org-chain scope (result→run→project); enqueue `attribute` (key = resultId) with house error pattern; 202. GET attribution: the row (or 404-when-none with `{pending: true}` 200 variant — return 200 `{ attribution: null }` when absent so the UI can poll).
- Attribution page (server component + evidence-client): loads result, question, attribution, gold document text, and the config chunk set's chunk offsets for that document. Renders: verdict badge (color per verdict), matched rule, explanation, counterfactual matrix table (kind, label, hit ✓/✗, rank), skipped-pairs note, and the EVIDENCE VIEW: the document text with the gold span wrapped in `<mark>` and chunk boundaries rendered as visible separators (e.g. a thin border/tick where each chunk starts, tooltip with chunk idx) — a straddled gold span must be visibly cut by a boundary line. Long docs: window the render to ±2000 chars around the gold span with expand controls.
- Run page cell drawer gains: Diagnose button (POST then poll GET; shows verdict badge inline once present; links to the attribution page).
- [ ] Steps: TDD the two routes (org 404s, enqueue assertion, null-attribution 200) → implement UI → full suite + typecheck → e2e smoke: from plan-4's smoke state, diagnose a missed cell → verdict appears in drawer → attribution page shows matrix + highlighted evidence with boundary cutting the span (screenshot-level check described in report) → commit `feat: diagnose flow with counterfactual matrix and span evidence view`.

---

## Out of scope
- Auto-embedding missing counterfactual pairs (v1 reports them skipped; the cost-surfaced flow is v1.1); batch "diagnose all misses"; attribution for non-question entities.
