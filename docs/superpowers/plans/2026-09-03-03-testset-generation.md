# RAGBench Test-Set Generation Implementation Plan (Plan 3 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extractive test sets with objectively verifiable ground truth: sample passages from ready documents, generate Q&A via LLM (or a deterministic demo-mode generator), verify every gold quote mechanically to a char-span, gate trivial questions, and ship a review UI — with a pre-flight cost estimate. Plus plan-2's deferred content-hash re-ingest no-op.

**Architecture:** A `generate-testset` worker job reads `documents.text` DIRECTLY (never chunk sets — they can be stale), samples passages round-robin across documents, and per passage asks the generator LLM for JSON `{question, answer, quote}`; `verifyQuote` (whitespace-normalized substring search in pure core) converts the verbatim quote to `goldStart/goldEnd` or drops the pair. `mock-llm` uses a deterministic local generator so keyless demo mode produces a real test set. `test_sets` gains status/progress columns (migration 0002). Web adds estimate + create + review APIs and a test-set page with question deletion.

**Tech Stack:** Existing stack; no new services or heavy deps.

**Spec:** `docs/superpowers/specs/2026-09-03-ragbench-design.md` (§5 fully; §3 judgment call 2 — extractive-only v1). Quality gate = cheap-LLM triviality filter per spec; skipped for mock-llm.

## Global Constraints

- Postgres host port 5433; default URL `postgres://ragbench:ragbench@localhost:5433/ragbench`.
- Every enqueue passes a distinct singletonKey; handlers idempotent (exclusive-policy queues).
- Providers only via `makeLLM`/`makeEmbedder` with `makeUsageReporter(db, organizationId)`; purpose `"testset"` for generation, `"testset-gate"` for the triviality gate. Tests keyless (mock-llm only).
- Registry lookups use `Object.hasOwn` (established in plan 2's fix wave) — follow that pattern for any new lookup.
- Gold-span invariant (tested): `normalize(docText.slice(goldStart, goldEnd)) === normalize(quote)` and the span is the exact region matched.
- Org-scoping via `requireProject` on every route; job payload `organizationId` comes from the session only.
- TypeScript strict; conventional commits, no Co-Authored-By trailer.
- Chunker/embedding params conventions unchanged; this plan does not touch chunk sets.

---

### Task 1: Plan-2 residuals + content-hash re-ingest no-op

**Files:**
- Modify: `apps/worker/src/handlers/parse.ts`, `apps/worker/src/handlers/chunk.ts`, `packages/core/src/chunkers.ts`, `apps/web/src/app/projects/[projectId]/corpus-client.tsx` (status badge)
- Test: extend `apps/worker/test/parse.test.ts`, `apps/worker/test/chunk-embed.test.ts`, `packages/core/test/chunkers.test.ts`

**Interfaces (four ruled residuals from plan 2's final review + the re-ingest no-op):**
1. **Duplicate re-ingest**: after successful extraction+hash in parse.ts, if ANOTHER document in the same project already has the same `contentHash` with status `ready`, the new document gets `status: "duplicate"` with `error: "duplicate of <filename>"` (text still stored). Ready-only filters everywhere already exclude duplicates. Corpus UI renders a grey "duplicate" badge. Both final updates stay OUTSIDE the extraction try (failure-attribution discipline).
2. **NUL strip covers the PDF branch**: move the NUL-strip (and keep the printability ratio check text-branch-only) so PDF-extracted text is also NUL-stripped before the ready-update — a PDF whose extraction yields NUL must not wedge at "parsing". Test: monkeypatch/simulate extracted text containing a NUL (e.g. factor the post-extraction sanitize into a small exported function `sanitizeExtractedText(text, {checkPrintable})` and unit-test it for both branch shapes).
3. **Batched chunk inserts**: chunkHandler inserts chunks in batches of at most 5,000 rows per statement (Postgres 65,535 bind-param cap ÷ 6 params/row with margin), still inside the one transaction. Test: a document producing > 5,000 chunks (small maxTokens on a large generated text) chunks successfully with correct total count.
4. **Clamp-to-fallback in core**: `size()`/`overlapSize` param normalization in chunkers.ts falls back to the DEFAULT (not the min) for out-of-range/non-numeric values — `chunkHeading(bigText, {maxChars: 0})` must produce default-sized chunks, not 1-char floods. Adjust the existing clamp tests accordingly.

- [ ] **Step 1: Failing tests** for all four behaviors (as described above).
- [ ] **Step 2: RED** — focused worker + core suites.
- [ ] **Step 3: Implement** all four.
- [ ] **Step 4: GREEN**, plus `pnpm -r test && pnpm -r typecheck`.
- [ ] **Step 5: Commit** `fix: plan-2 residuals — duplicate reingest, pdf nul strip, batched inserts, clamp fallback`.

---

### Task 2: Quote verification + passage sampling (core, pure)

**Files:**
- Create: `packages/core/src/testset.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/testset.test.ts`

**Interfaces:**
- Produces:
  - `normalizeWs(s: string): string` — collapse all whitespace runs to single spaces, trim.
  - `verifyQuote(docText: string, quote: string): { start: number; end: number } | null` — find the quote in docText tolerating whitespace differences (algorithm below); returns the exact char-span in the ORIGINAL text; null when absent or when quote normalizes to < 12 chars (too short to be meaningful ground truth).
  - `samplePassages(docText: string, count: number, passageChars?: number): Array<{ text: string; start: number; end: number }>` — up to `count` non-overlapping passages of ~`passageChars` (default 1200), evenly spread across the document, snapped to whitespace boundaries; whole doc as one passage when short.
  - `parseQaJson(raw: string): Array<{ question: string; answer: string; quote: string }>` — extracts the first JSON array from raw LLM output (tolerates code fences and surrounding prose); returns [] on unparseable input; filters entries missing any of the three string fields.

**verifyQuote algorithm (implement exactly):** build an index mapping of `docText`'s non-whitespace characters to their original positions plus a parallel normalized string (single spaces); normalize the quote the same way; `indexOf` the normalized quote in the normalized doc; map the match's first/last character back through the position index to get `{start, end}` (end exclusive, spanning the original including its internal whitespace).

- [ ] **Step 1: Failing tests** — cases: exact match; quote with different internal whitespace/newlines than the doc; quote at doc start and end; absent quote → null; short quote (< 12 normalized chars) → null; unicode text; span-correctness assertion `normalizeWs(doc.slice(start,end)) === normalizeWs(quote)` on every hit. samplePassages: long doc yields `count` non-overlapping spans covering spread positions with `doc.slice(start,end) === text`; short doc yields one passage; count 0 → []. parseQaJson: bare array; fenced ```json array; array embedded in prose; garbage → []; entries with missing fields filtered.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** per the interfaces (pure, node-only, no deps).
- [ ] **Step 4: GREEN** + typecheck.
- [ ] **Step 5: Commit** `feat: quote verification, passage sampling and qa parsing`.

---

### Task 3: Generation prompts + deterministic demo generator (core)

**Files:**
- Create: `packages/core/src/testset-prompts.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/testset-prompts.test.ts`

**Interfaces:**
- Produces:
  - `buildGenerationPrompt(passage: string, n: number): string` — asks for exactly `n` extractive Q&A pairs as a JSON array of `{question, answer, quote}`; instructs: quote must be VERBATIM from the passage; answer must be contained in the quote; questions must be natural (not quoting rare phrasing verbatim from the passage).
  - `buildTrivialityGatePrompt(question: string, quote: string): string` — asks for strict JSON `{"trivial": boolean}`; trivial = the question contains a distinctive verbatim phrase from the quote making string-matching sufficient.
  - `parseGateJson(raw: string): boolean | null` — extracts the boolean; null on parse failure (caller keeps the question when the gate is unparseable — fail open).
  - `mockGenerateQa(passage: { text: string; start: number }, n: number): Array<{ question: string; answer: string; quote: string }>` — deterministic demo-mode generator: split the passage into sentences (reuse the sentence regex approach from chunkers), take the first `n` sentences of ≥ 30 chars; for each, quote = the sentence, answer = the sentence, question = `What does the document state about ${first five words of the sentence}?`. No randomness.
- [ ] **Step 1: Failing tests** — prompts contain the passage/n and the JSON-array instruction (don't over-assert wording); parseGateJson on `{"trivial":true}`, fenced, garbage→null; mockGenerateQa determinism (same input → same output), n respected, quotes verbatim substrings of the passage (verifiable via verifyQuote against the passage text).
- [ ] **Step 2: RED.**  **Step 3: Implement.**  **Step 4: GREEN + typecheck.**
- [ ] **Step 5: Commit** `feat: testset generation prompts and deterministic demo generator`.

---

### Task 4: Migration 0002 (test_sets status + chunk_sets fingerprint) and rebuild-skip

**Files:**
- Modify: `packages/db/src/schema.ts`, `apps/worker/src/handlers/chunk.ts`
- Create: generated `packages/db/migrations/0002_*.sql`
- Test: extend `packages/db/test/schema.test.ts`, `apps/worker/test/chunk-embed.test.ts`

**Interfaces:**
- Schema, on `testSets`: `status: text default "generating"` (`generating | ready | failed`), `error: text` nullable, `questionsTarget: integer notNull default 30`. On `chunkSets`: `docsFingerprint: text` nullable. Non-destructive ALTERs only (inspect generated SQL; STOP if destructive).
- **Rebuild-skip (plan-2 ruled residual — the re-POST cost bug):** chunkHandler computes `fingerprint = sha256(paramsHash + ":" + sortedJoin(ready docs' contentHashes))` up front. If it equals the set's stored `docsFingerprint` AND the set has chunks, SKIP the delete-and-recreate entirely — but STILL chain the embed enqueue when the payload carries embedModel (skip-existing makes an already-embedded model a cheap no-op, and a new model gets embedded without destroying anything). On an actual rebuild, store the new fingerprint in the same transaction.
- [ ] **Step 1: Failing tests**: (db) test_set defaults; chunk_sets accepts fingerprint. (worker) run chunkHandler twice with unchanged docs/params + a recording boss: second run leaves chunk row IDs IDENTICAL (no teardown) and still enqueues embed when embedModel present; then mark a new doc ready and run again: chunks rebuilt (IDs change), fingerprint updated.
- [ ] **Step 2: RED.**  **Step 3: Schema edits + generate + inspect + `pnpm db:migrate`; implement rebuild-skip.**  **Step 4: GREEN + full suite.**
- [ ] **Step 5: Commit** `feat: test set status columns and fingerprint-gated chunk rebuilds`.

---

### Task 5: generate-testset worker job

**Files:**
- Create: `apps/worker/src/handlers/generate-testset.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/worker/test/generate-testset.test.ts`

**Interfaces:**
- Consumes: core testset/prompts modules; `makeLLM`, `CHEAP_LLM`; `makeUsageReporter`; tables.
- Produces: `generateTestsetHandler: JobHandler<{ testSetId: string; organizationId: string }>`:
  1. Load the test set; missing → no-op. If status already `ready` → no-op (idempotent retry).
  2. Load `ready` documents of the project with non-null text; none → status `failed`, error "no ready documents".
  3. Compute per-doc passage quota: round-robin `samplePassages(doc.text, ...)` across docs until `questionsTarget` passages (ask 1 Q per passage; passages exhausted → proceed with fewer).
  4. For each passage: if `generatorModel === "mock-llm"` → `mockGenerateQa(passage, 1)`; else `makeLLM(generatorModel, reporter, "testset").complete({ prompt: buildGenerationPrompt(passage.text, 1), maxTokens: 800 })` → `parseQaJson`.
  5. For each candidate: `verifyQuote(doc.text, quote)` — null → drop (count it); else triviality gate: skip for mock-llm; else `makeLLM(CHEAP_LLM, reporter, "testset-gate")` + `buildTrivialityGatePrompt` + `parseGateJson` — `true` → drop, `false`/null → keep.
  6. Insert kept questions (`testQuestions` with documentId, question, goldAnswer = answer, span from verifyQuote) — insert as you go, per passage.
  7. Finish: status `ready` (even with fewer than target; note counts in no field — the UI shows actual counts). ProviderErrors propagate (pg-boss retries; step 1's idempotency check plus per-question inserts mean a retry resumes with what's already inserted counted toward the target: re-count existing active questions at start and generate only the remainder).
  - Enqueue convention (task 6): queue `"generate-testset"`, singletonKey = testSetId.
- [ ] **Step 1: Failing tests** (mock-llm only): (a) happy path — seed project with 2 ready docs (multi-sentence texts), test set with target 6, run handler → status ready, 1–6 active questions, every question's span satisfies the gold-span invariant against its document's text, usage_log untouched by mock generation is OK (mock reports synthetic usage — assert ≥ 0 rows, don't overfit); (b) resume/idempotency — run the handler twice; total active questions ≤ target and status ready (no duplicates beyond target); (c) no ready docs → failed with error; (d) missing test set id → resolves without throwing.
- [ ] **Step 2: RED.**  **Step 3: Implement.**  **Step 4: GREEN + full suite + typecheck.**
- [ ] **Step 5: Commit** `feat: generate-testset job with verified extractive ground truth`.

---

### Task 6: Test-set APIs (estimate, create, list, questions)

**Files:**
- Create: `apps/web/src/app/api/projects/[projectId]/test-sets/route.ts`, `apps/web/src/app/api/projects/[projectId]/test-sets/estimate/route.ts`, `apps/web/src/app/api/test-sets/[testSetId]/questions/route.ts`, `apps/web/src/app/api/questions/[questionId]/route.ts`
- Test: `apps/web/test/test-sets.test.ts`

**Interfaces:**
- `GET .../test-sets/estimate?model=M&count=N` → `{ inputTokens, outputTokens, estimatedUsd, documents }` — heuristic: per question, input ≈ 350 + passageChars/4 tokens, output ≈ 200; gate adds (for non-mock) 150 in / 10 out at CHEAP_LLM prices; `estimatedUsd` via registry (Object.hasOwn; 400 unknown model; mock → 0). `documents` = count of ready docs (0 → still 200 with a `warning` field).
- `POST .../test-sets` — Zod `{ name: min 1, generatorModel: keyof LLM_MODELS (hasOwn, 400 unknown), questionsTarget: int 1..200 default 30 }`; requireProject; inserts test_sets row (status generating) and enqueues `generate-testset` (singletonKey = testSetId, organizationId from session) with the same try/catch→500 recoverability pattern as chunk-sets; 201. Re-POST creates a NEW set (test sets are point-in-time snapshots — no upsert). Injectable session+send internals (`createTestSet`, `listTestSets`).
- `GET .../test-sets` → sets with active-question counts (left join).
- `GET /api/test-sets/:id/questions` → active questions incl. document filename (join); org-scoped via the set's project (404 foreign). `listQuestions(testSetId, session)` internal.
- `DELETE /api/questions/:id` → sets status `deleted`; org-scoped via question→set→project chain; 404 foreign. `deleteQuestion(questionId, session)` internal.
- [ ] **Step 1: Failing tests** — estimate math for mock (0 usd) and claude-haiku-4-5 (>0, plausible magnitude), unknown model 400; create+enqueue with fake send (key = set id) + 201 + row status generating; list with counts; questions list joins filename; delete flips status and excludes from list; foreign-org 404 on every route; unauthenticated 401.
- [ ] **Step 2: RED.**  **Step 3: Implement** (mirror chunk-sets/documents route patterns exactly).  **Step 4: GREEN + full suite + typecheck.**
- [ ] **Step 5: Commit** `feat: test set apis with pre-flight cost estimate and question review`.

---

### Task 7: Test-set UI + e2e smoke

**Files:**
- Create: `apps/web/src/app/projects/[projectId]/test-sets-client.tsx`, `apps/web/src/app/test-sets/[testSetId]/page.tsx`, `apps/web/src/app/test-sets/[testSetId]/questions-client.tsx`
- Modify: `apps/web/src/app/projects/[projectId]/page.tsx` (mount test-sets section under the corpus section)
- Test: extend `apps/web/test/test-sets.test.ts` only if internals change; UI is smoke-covered.

**Interfaces:**
- Project page gains a "Test sets" section (`test-sets-client.tsx`): form (name, generator model select [mock-llm, claude-haiku-4-5, claude-opus-5, gemini-2.5-flash], target number) showing the live estimate (fetch on model/target change, display `~$X.XXXX` and doc count warning); table of sets (name, model, status badge, question count, created) polling every 2s; each row links to `/test-sets/[id]`.
- Test-set page: guarded server component (session + ownership via the set's project); `questions-client.tsx` renders the questions table (question, gold answer, source filename, span start–end) with per-row Delete buttons calling the DELETE API then refreshing; polls every 2s while the set's status is `generating`.
- Styling: existing cool-neutral system; status colors only.
- [ ] **Step 1: Implement** the three components + page wiring (no new route internals).
- [ ] **Step 2: Full suite + typecheck.**
- [ ] **Step 3: E2E smoke (documented in report):** RAGBENCH_UPLOADS_DIR=<repo>/uploads for worker+web (port 3300); migrate; sign up fresh; create project; upload the markdown fixture; wait ready; create test set (mock-llm, target 5) — estimate shows $0.0000; watch status generating→ready; open the set page; verify questions listed with spans; delete one; verify it disappears and psql shows status deleted; verify usage_log rows for purpose testset (mock synthetic). Stop servers.
- [ ] **Step 4: Commit** `feat: test set generation ui with estimate and question review`.

---

## Out of scope for this plan

- Configs/eval runs/judging (plan 4), attribution (plan 5), launch polish (plan 6).
- Multi-hop/abstractive questions (v2 per spec); human-authored test sets; question editing (delete-only in v1).
- Real-key generation smoke (wiring identical to mock; optional manual).
