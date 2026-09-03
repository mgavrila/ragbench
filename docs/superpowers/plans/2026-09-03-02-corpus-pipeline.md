# RAGBench Corpus Pipeline Implementation Plan (Plan 2 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Documents in, embeddings out: upload PDFs/Markdown, parse them in the worker, chunk under three strategies, embed chunk sets per model with metered usage — plus the deferred foundation items (provider error taxonomy, usage reporter, FK indexes, cascade deletes).

**Architecture:** Upload lands the file in an `uploads/` volume and enqueues a `parse` job (pg-boss, distinct singletonKeys — exclusive-policy constraint). Worker parses (unpdf for PDF, passthrough for text/markdown), chunkers are pure functions in `packages/core` producing char-offset chunks (verbatim-substring invariant), `chunk`/`embed` jobs materialize chunk_sets and chunk_embeddings idempotently. Web gets a send-only pg-boss client, document/chunk-set APIs (all org-scoped), and a project corpus page with status polling.

**Tech Stack:** Existing monorepo (Next 16, Drizzle, pg-boss 12, Auth.js v5) + `unpdf`. No new services.

**Spec:** `docs/superpowers/specs/2026-09-03-ragbench-design.md` (§4 ingestion; §2 metering; §3 schema). This plan implements §4 fully except non-PDF/MD formats (deferred by spec).

## Global Constraints

- Postgres on host port 5433; default/fallback URL `postgres://ragbench:ragbench@localhost:5433/ragbench` everywhere.
- pg-boss queues are exclusive-policy: EVERY enqueue passes a distinct `singletonKey` (job identity = its idempotency key). Handlers must be idempotent — batch retry can re-run an already-succeeded job.
- `packages/core` never imports db/next/pg-boss; DB-aware shared code goes in `packages/db`.
- All provider calls go through `makeLLM`/`makeEmbedder`; tests use mock providers only (CI is keyless).
- Chunk invariant: for every produced chunk, `documentText.slice(startOffset, endOffset) === chunk.text`.
- Every API route verifies the project belongs to `session.user.organizationId` before touching child rows.
- TypeScript strict; conventional commits, no Co-Authored-By trailer.
- Uploads directory: `<repo>/uploads/<documentId>` (gitignored already); no S3.

---

### Task 1: Provider error taxonomy (core)

**Files:**
- Create: `packages/core/src/providers/errors.ts`
- Modify: `packages/core/src/providers/anthropic.ts`, `packages/core/src/providers/openai.ts`, `packages/core/src/providers/google.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/errors.test.ts`

**Interfaces:**
- Produces: `type ProviderErrorKind = "rate_limit" | "auth" | "transient" | "fatal"`; `class ProviderError extends Error { kind; provider; retryable (true for rate_limit|transient); cause? }`; `toProviderError(provider: string, err: unknown): ProviderError` mapping HTTP-ish status codes (429→rate_limit; 401/403→auth; ≥500 and network errors→transient; else fatal; already-a-ProviderError passes through). All real providers wrap their SDK calls so callers only ever see `ProviderError`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ProviderError, toProviderError } from "../src/providers/errors";

function httpErr(status: number) {
  const e = new Error(`http ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

describe("provider error taxonomy", () => {
  it("maps status codes to kinds", () => {
    expect(toProviderError("anthropic", httpErr(429)).kind).toBe("rate_limit");
    expect(toProviderError("openai", httpErr(401)).kind).toBe("auth");
    expect(toProviderError("openai", httpErr(403)).kind).toBe("auth");
    expect(toProviderError("google", httpErr(500)).kind).toBe("transient");
    expect(toProviderError("google", httpErr(529)).kind).toBe("transient");
    expect(toProviderError("anthropic", httpErr(400)).kind).toBe("fatal");
  });

  it("treats connection-ish errors as transient", () => {
    const e = new Error("fetch failed") as Error & { code: string };
    e.code = "ECONNRESET";
    expect(toProviderError("openai", e).kind).toBe("transient");
  });

  it("marks retryable correctly and preserves cause + provider", () => {
    const pe = toProviderError("anthropic", httpErr(429));
    expect(pe.retryable).toBe(true);
    expect(pe.provider).toBe("anthropic");
    expect(pe.cause).toBeInstanceOf(Error);
    expect(toProviderError("anthropic", httpErr(400)).retryable).toBe(false);
    expect(toProviderError("anthropic", httpErr(401)).retryable).toBe(false);
  });

  it("passes through an existing ProviderError unchanged", () => {
    const orig = new ProviderError("fatal", "anthropic", "nope");
    expect(toProviderError("anthropic", orig)).toBe(orig);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ragbench/core test`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

`packages/core/src/providers/errors.ts`:
```ts
export type ProviderErrorKind = "rate_limit" | "auth" | "transient" | "fatal";

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.retryable = kind === "rate_limit" || kind === "transient";
  }
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

export function toProviderError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const anyErr = err as { status?: number; code?: string; message?: string };
  const message = anyErr?.message ?? String(err);
  const status = typeof anyErr?.status === "number" ? anyErr.status : undefined;
  let kind: ProviderErrorKind;
  if (status === 429) kind = "rate_limit";
  else if (status === 401 || status === 403) kind = "auth";
  else if (status !== undefined && status >= 500) kind = "transient";
  else if (status !== undefined) kind = "fatal";
  else if (anyErr?.code && TRANSIENT_CODES.has(anyErr.code)) kind = "transient";
  else kind = "fatal";
  return new ProviderError(kind, provider, message, { cause: err });
}
```

Then wrap every SDK call site: in `anthropic.ts` wrap the `this.client.messages.create(...)` await in try/catch rethrowing `toProviderError("anthropic", err)`; same in `openai.ts` around `embeddings.create` (per batch) and in `google.ts` around `generateContent`/`embedContent` (per call/batch). The existing "LLM returned no text" throw in anthropic.ts becomes `new ProviderError("fatal", "anthropic", ...)`.

Add to `packages/core/src/index.ts`: `export * from "./providers/errors";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ragbench/core test` — expected PASS (all existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat: provider error taxonomy with retryability"
```

---

### Task 2: Usage reporter (db)

**Files:**
- Create: `packages/db/src/usage.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/package.json` (add `@ragbench/core` dep)
- Test: `packages/db/test/usage.test.ts`

**Interfaces:**
- Consumes: `usageLog` table; `LLM_MODELS`, `EMBEDDING_MODELS`, `estimateLlmCostUsd`, `estimateEmbeddingCostUsd`, `UsageReporter` from core.
- Produces: `makeUsageReporter(db: Db, organizationId: string): UsageReporter` — inserts one `usage_log` row per call; cost from the registry (LLM models via `estimateLlmCostUsd`; embedding models via `estimateEmbeddingCostUsd(inputTokens)`; unknown model → cost 0, still logged). **All pipeline jobs and later plans meter exclusively through this.**

- [ ] **Step 1: Install dep**

Run: `pnpm add --filter @ragbench/db @ragbench/core`

- [ ] **Step 2: Write the failing test**

`packages/db/test/usage.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb } from "../src/client";
import { organizations, usageLog } from "../src/schema";
import { makeUsageReporter } from "../src/usage";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
let ctx: Awaited<ReturnType<typeof createDb>>;
let orgId: string;

beforeAll(async () => {
  await migrateDb(URL);
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "usage-org" }).returning();
  orgId = org.id;
});
afterAll(async () => { await ctx.pool.end(); });

describe("makeUsageReporter", () => {
  it("logs LLM usage with registry-priced cost", async () => {
    const report = makeUsageReporter(ctx.db, orgId);
    await report({ purpose: "testset", provider: "anthropic", model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const rows = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBeCloseTo(30);
    expect(rows[0].purpose).toBe("testset");
  });

  it("logs embedding usage and zero-cost unknown models", async () => {
    const report = makeUsageReporter(ctx.db, orgId);
    await report({ purpose: "embed", provider: "openai", model: "text-embedding-3-small", inputTokens: 1_000_000, outputTokens: 0 });
    await report({ purpose: "embed", provider: "mock", model: "not-registered", inputTokens: 5, outputTokens: 0 });
    const rows = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    const small = rows.find((r) => r.model === "text-embedding-3-small")!;
    const unknown = rows.find((r) => r.model === "not-registered")!;
    expect(small.costUsd).toBeCloseTo(0.02);
    expect(unknown.costUsd).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `pnpm --filter @ragbench/db test` → FAIL (module missing).

- [ ] **Step 4: Write the implementation**

`packages/db/src/usage.ts`:
```ts
import {
  LLM_MODELS, EMBEDDING_MODELS, estimateLlmCostUsd, estimateEmbeddingCostUsd,
  type UsageReporter,
} from "@ragbench/core";
import { usageLog } from "./schema";
import type { Db } from "./client";

export function makeUsageReporter(db: Db, organizationId: string): UsageReporter {
  return async ({ purpose, provider, model, inputTokens, outputTokens }) => {
    let costUsd = 0;
    if (LLM_MODELS[model]) costUsd = estimateLlmCostUsd(model, inputTokens, outputTokens);
    else if (EMBEDDING_MODELS[model]) costUsd = estimateEmbeddingCostUsd(model, inputTokens);
    await db.insert(usageLog).values({ organizationId, purpose, provider, model, inputTokens, outputTokens, costUsd });
  };
}
```

Add `export * from "./usage";` to `packages/db/src/index.ts`.

- [ ] **Step 5: Run tests to verify they pass** — `pnpm --filter @ragbench/db test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db && git commit -m "feat: org-scoped usage reporter with registry pricing"
```

---

### Task 3: FK indexes + cascade deletes (schema migration)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: generated `packages/db/migrations/0001_*.sql` (via drizzle-kit)
- Test: extend `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces: corpus-chain cascade — deleting a `document` removes its `chunks` and their `chunk_embeddings`; deleting a `chunk_set` removes its `chunks`+embeddings; deleting a `project` removes documents/chunk_sets/rag_configs/test_sets (and transitively). Eval-side rows (`question_results`, `attributions`, `eval_runs`) cascade from their parents too. `users`/`usage_log` keep default no-action (org deletion is out of scope). Indexes on: `projects.organization_id`, `documents.project_id`, `chunk_sets.project_id`, `chunks.chunk_set_id`, `chunks.document_id`, `chunk_embeddings.chunk_id`, `usage_log.organization_id`, `test_questions.test_set_id`, `question_results.run_id`.

**Ruling encoded here (controller):** hard cascade for project-owned data, chosen over soft delete — v1 has no recovery story and cascades keep counterfactual cleanup trivial. No delete UI ships in this plan.

- [ ] **Step 1: Write the failing test** (append to `packages/db/test/schema.test.ts`)

```ts
import { chunkSets as cs2 } from "../src/schema"; // adjust imports to existing style at top of file

it("cascades document deletion through chunks to embeddings", async () => {
  const [org] = await ctx.db.insert(organizations).values({ name: "cascade-org" }).returning();
  const [proj] = await ctx.db.insert(projects).values({ organizationId: org.id, name: "cascade-proj" }).returning();
  const [doc] = await ctx.db.insert(documents).values({
    projectId: proj.id, filename: "c.md", mime: "text/markdown", contentHash: "ch", text: "hello", status: "ready",
  }).returning();
  const [set] = await ctx.db.insert(chunkSets).values({
    projectId: proj.id, chunker: "fixed", params: { size: 1 }, paramsHash: "cph",
  }).returning();
  const [chunk] = await ctx.db.insert(chunks).values({
    chunkSetId: set.id, documentId: doc.id, idx: 0, text: "hello", startOffset: 0, endOffset: 5,
  }).returning();
  await ctx.db.insert(chunkEmbeddings).values({ chunkId: chunk.id, model: "mock-embedding", dimension: 3, embedding: [1, 0, 0] });

  await ctx.db.delete(documents).where(eq(documents.id, doc.id));
  expect(await ctx.db.select().from(chunks).where(eq(chunks.documentId, doc.id))).toHaveLength(0);
  expect(await ctx.db.select().from(chunkEmbeddings).where(eq(chunkEmbeddings.chunkId, chunk.id))).toHaveLength(0);
});
```
(Add the needed `eq` / table imports to the file's existing import lines.)

- [ ] **Step 2: Run to verify it fails** — delete currently violates the FK → error, test FAILS.

- [ ] **Step 3: Amend the schema**

In `packages/db/src/schema.ts`: change the corpus/eval-side `.references(() => X.id)` calls to `.references(() => X.id, { onDelete: "cascade" })` for: `documents.projectId`, `chunkSets.projectId`, `chunks.chunkSetId`, `chunks.documentId`, `chunkEmbeddings.chunkId`, `ragConfigs.projectId`, `ragConfigs.chunkSetId`, `testSets.projectId`, `testQuestions.testSetId`, `testQuestions.documentId`, `evalRuns.projectId`, `evalRuns.testSetId`, `evalRunConfigs.runId`, `evalRunConfigs.configId`, `questionResults.runId`, `questionResults.configId`, `questionResults.questionId`, `attributions.resultId`. Leave `users.organizationId`, `usageLog.organizationId`, `projects.organizationId` as-is (no action).

Add plain indexes (import `index` from drizzle pg-core) in each table's extras array, e.g. for documents: `index("documents_project_idx").on(t.projectId)` — likewise `projects_org_idx`, `chunk_sets_project_idx`, `chunks_set_idx`, `chunks_doc_idx`, `chunk_embeddings_chunk_idx`, `usage_log_org_idx`, `test_questions_set_idx`, `question_results_run_idx`.

- [ ] **Step 4: Generate + apply migration**

Run: `pnpm --filter @ragbench/db generate` → inspect `0001_*.sql`: must ALTER the FK constraints to `ON DELETE CASCADE` and CREATE the 9 indexes. Then `pnpm db:migrate` (env DATABASE_URL on 5433).

- [ ] **Step 5: Run tests to verify they pass** — `pnpm --filter @ragbench/db test` → PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db && git commit -m "feat: fk indexes and cascade deletes for project-owned data"
```

---

### Task 4: Chunkers (core, pure)

**Files:**
- Create: `packages/core/src/chunkers.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/chunkers.test.ts`

**Interfaces:**
- Produces: `type Chunk = { text: string; startOffset: number; endOffset: number }`; `chunkFixed(text, params: { maxTokens?: number; overlapTokens?: number })` (defaults 200/40; "tokens" = whitespace-delimited words); `chunkHeading(text, params: { maxChars?: number })` (default 4000; split before every markdown heading line `/^#{1,6} /m`; sections longer than maxChars are hard-split at maxChars); `chunkSentenceWindow(text, params: { windowSentences?: number; overlapSentences?: number })` (defaults 5/1; sentences end at `.`/`!`/`?` followed by whitespace, or end-of-text); `CHUNKERS: Record<string, (text: string, params: Record<string, unknown>) => Chunk[]>` keyed `"fixed" | "heading" | "sentence-window"`; `hashParams(params: Record<string, unknown>): string` — sha256 hex of JSON with sorted keys (stable across key order).
- Invariants (tested): every chunk satisfies `text === input.slice(startOffset, endOffset)`; chunks are non-empty; offsets are non-decreasing across the array; empty/whitespace-only input → `[]`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/chunkers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { chunkFixed, chunkHeading, chunkSentenceWindow, CHUNKERS, hashParams, type Chunk } from "../src/chunkers";

function assertInvariants(input: string, out: Chunk[]) {
  for (const c of out) {
    expect(c.text.length).toBeGreaterThan(0);
    expect(input.slice(c.startOffset, c.endOffset)).toBe(c.text);
  }
  for (let i = 1; i < out.length; i++) expect(out[i].startOffset).toBeGreaterThanOrEqual(out[i - 1].startOffset);
}

const WORDS = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
const MD = "# Title\nintro text here\n\n## Section A\n" + "alpha ".repeat(50) + "\n\n## Section B\nbeta text";
const PROSE = "One sentence here. Two follows! Three asks? Four ends. Five closes. Six more. Seven again.";

describe("chunkFixed", () => {
  it("splits by word count with overlap and verbatim offsets", () => {
    const out = chunkFixed(WORDS, { maxTokens: 100, overlapTokens: 20 });
    assertInvariants(WORDS, out);
    expect(out.length).toBeGreaterThan(4);
    // consecutive chunks overlap: next starts before previous ends
    expect(out[1].startOffset).toBeLessThan(out[0].endOffset);
  });
  it("returns one chunk for short input and [] for empty", () => {
    expect(chunkFixed("just a few words", {})).toHaveLength(1);
    expect(chunkFixed("", {})).toEqual([]);
    expect(chunkFixed("   \n  ", {})).toEqual([]);
  });
});

describe("chunkHeading", () => {
  it("splits before markdown headings", () => {
    const out = chunkHeading(MD, {});
    assertInvariants(MD, out);
    expect(out.length).toBe(3);
    expect(out[1].text.startsWith("## Section A")).toBe(true);
  });
  it("hard-splits oversized sections and handles heading-free text", () => {
    const big = "no headings " + "x".repeat(10_000);
    const out = chunkHeading(big, { maxChars: 3000 });
    assertInvariants(big, out);
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(3000);
  });
});

describe("chunkSentenceWindow", () => {
  it("windows sentences with overlap", () => {
    const out = chunkSentenceWindow(PROSE, { windowSentences: 3, overlapSentences: 1 });
    assertInvariants(PROSE, out);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].text).toContain("One sentence here.");
  });
  it("handles unicode text without corrupting offsets", () => {
    const uni = "Émile écrit. Ça marche bien! Encore ça? Fin.";
    assertInvariants(uni, chunkSentenceWindow(uni, { windowSentences: 2, overlapSentences: 0 }));
  });
});

describe("registry + params hash", () => {
  it("exposes all three chunkers", () => {
    expect(Object.keys(CHUNKERS).sort()).toEqual(["fixed", "heading", "sentence-window"]);
  });
  it("hashParams is stable across key order and distinct across values", () => {
    expect(hashParams({ a: 1, b: 2 })).toBe(hashParams({ b: 2, a: 1 }));
    expect(hashParams({ a: 1 })).not.toBe(hashParams({ a: 2 }));
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — module missing.

- [ ] **Step 3: Write the implementation**

`packages/core/src/chunkers.ts`:
```ts
import { createHash } from "node:crypto";

export type Chunk = { text: string; startOffset: number; endOffset: number };

type Span = { start: number; end: number };

function tokenSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length });
  return spans;
}

function slice(text: string, start: number, end: number): Chunk {
  return { text: text.slice(start, end), startOffset: start, endOffset: end };
}

export function chunkFixed(text: string, params: { maxTokens?: number; overlapTokens?: number }): Chunk[] {
  const maxTokens = params.maxTokens ?? 200;
  const overlap = Math.min(params.overlapTokens ?? 40, maxTokens - 1);
  const spans = tokenSpans(text);
  if (spans.length === 0) return [];
  const out: Chunk[] = [];
  let i = 0;
  while (i < spans.length) {
    const last = Math.min(i + maxTokens, spans.length);
    out.push(slice(text, spans[i].start, spans[last - 1].end));
    if (last === spans.length) break;
    i = last - overlap;
  }
  return out;
}

export function chunkHeading(text: string, params: { maxChars?: number }): Chunk[] {
  const maxChars = params.maxChars ?? 4000;
  if (text.trim().length === 0) return [];
  const starts = [0];
  const re = /^#{1,6} /gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (m.index !== 0) starts.push(m.index);
  const out: Chunk[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : text.length;
    for (let p = start; p < end; p += maxChars) {
      const c = slice(text, p, Math.min(p + maxChars, end));
      if (c.text.trim().length > 0) out.push(c);
    }
  }
  return out;
}

function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /[^.!?]*[.!?]+(?=\s|$)|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].trim().length > 0) spans.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return spans;
}

export function chunkSentenceWindow(
  text: string,
  params: { windowSentences?: number; overlapSentences?: number },
): Chunk[] {
  const win = params.windowSentences ?? 5;
  const overlap = Math.min(params.overlapSentences ?? 1, win - 1);
  const spans = sentenceSpans(text);
  if (spans.length === 0) return [];
  const out: Chunk[] = [];
  let i = 0;
  while (i < spans.length) {
    const last = Math.min(i + win, spans.length);
    out.push(slice(text, spans[i].start, spans[last - 1].end));
    if (last === spans.length) break;
    i = last - overlap;
  }
  return out;
}

export const CHUNKERS: Record<string, (text: string, params: Record<string, unknown>) => Chunk[]> = {
  fixed: (t, p) => chunkFixed(t, p as { maxTokens?: number; overlapTokens?: number }),
  heading: (t, p) => chunkHeading(t, p as { maxChars?: number }),
  "sentence-window": (t, p) => chunkSentenceWindow(t, p as { windowSentences?: number; overlapSentences?: number }),
};

export function hashParams(params: Record<string, unknown>): string {
  const stable = JSON.stringify(params, Object.keys(params).sort());
  return createHash("sha256").update(stable).digest("hex");
}
```

Add `export * from "./chunkers";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run tests** — `pnpm --filter @ragbench/core test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat: fixed, heading and sentence-window chunkers with offset invariants"
```

---

### Task 5: Parse pipeline (worker) + upload storage helper

**Files:**
- Create: `apps/worker/src/handlers/parse.ts`, `packages/db/src/files.ts`, `apps/worker/test/fixtures/make-fixtures.ts`
- Modify: `apps/worker/src/main.ts`, `apps/worker/package.json` (add `unpdf`), `packages/db/src/index.ts`
- Test: `apps/worker/test/parse.test.ts`

**Interfaces:**
- Consumes: `documents` table; `Db`.
- Produces:
  - `uploadsDir()` and `documentPath(documentId)` in `packages/db/src/files.ts` — single source of truth for file locations (`RAGBENCH_UPLOADS_DIR` env override, default `<cwd>/uploads`; `mkdir -p` on demand). Web (Task 7) uses the same helpers.
  - `parseHandler: JobHandler<{ documentId: string }>` — reads the uploaded file, extracts text (PDF via `unpdf`'s `extractText`; `text/*` mimes via utf-8 read), computes sha256 `contentHash`, updates the row to `status: "ready"` with `text`; on extraction failure sets `status: "failed"` + `error` and does NOT throw (a bad file is fatal, not retryable); missing file row → return silently (idempotent). Registered in `main.ts` as queue `"parse"`.
  - Enqueue convention (used by Task 7): queue `"parse"`, `singletonKey = documentId`.

- [ ] **Step 1: Install dep + fixtures script**

Run: `pnpm add --filter @ragbench/worker unpdf`

`apps/worker/test/fixtures/make-fixtures.ts` (run once with `tsx`, commit the outputs):
```ts
// Generates a minimal one-page PDF containing the text "RAGBench fixture PDF"
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
mkdirSync(dir, { recursive: true });

const content = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 62 >> stream
BT /F1 24 Tf 72 700 Td (RAGBench fixture PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
writeFileSync(join(dir, "sample.pdf"), content);
writeFileSync(join(dir, "sample.md"), "# Fixture\n\nRAGBench markdown fixture body.\n");
console.log("fixtures written");
```
Run: `pnpm --filter @ragbench/worker exec tsx test/fixtures/make-fixtures.ts` and verify `unpdf` can read it in Step 4 (if `unpdf` rejects the hand-rolled PDF, regenerate the fixture with `pdf-lib` as a devDependency instead — the test is the contract).

- [ ] **Step 2: Write the failing test**

`apps/worker/test/parse.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, organizations, projects, documents, documentPath } from "@ragbench/db";
import { parseHandler } from "../src/handlers/parse";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let ctx: ReturnType<typeof createDb>;
let projectId: string;

beforeAll(async () => {
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "parse-org" }).returning();
  const [proj] = await ctx.db.insert(projects).values({ organizationId: org.id, name: "parse-proj" }).returning();
  projectId = proj.id;
});
afterAll(async () => { await ctx.pool.end(); });

async function makeDoc(filename: string, mime: string, fixture?: string) {
  const [doc] = await ctx.db.insert(documents).values({
    projectId, filename, mime, contentHash: "pending", status: "parsing",
  }).returning();
  if (fixture) {
    mkdirSync(dirname(documentPath(doc.id)), { recursive: true });
    copyFileSync(join(FIXTURES, fixture), documentPath(doc.id));
  }
  return doc;
}

describe("parseHandler", () => {
  it("parses markdown to ready with text and content hash", async () => {
    const doc = await makeDoc("sample.md", "text/markdown", "sample.md");
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("ready");
    expect(row.text).toContain("RAGBench markdown fixture body");
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses PDF text", async () => {
    const doc = await makeDoc("sample.pdf", "application/pdf", "sample.pdf");
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("ready");
    expect(row.text).toContain("RAGBench fixture PDF");
  });

  it("marks unreadable files failed without throwing", async () => {
    const doc = await makeDoc("ghost.pdf", "application/pdf"); // no file on disk
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
  });

  it("is a no-op for unknown document ids", async () => {
    await expect(parseHandler({ documentId: "00000000-0000-0000-0000-000000000000" }, { db: ctx.db, boss: null as never })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify FAIL** — modules missing.

- [ ] **Step 4: Write the implementation**

`packages/db/src/files.ts`:
```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function uploadsDir(): string {
  const dir = process.env.RAGBENCH_UPLOADS_DIR ?? join(process.cwd(), "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function documentPath(documentId: string): string {
  return join(uploadsDir(), documentId);
}
```
Export from `packages/db/src/index.ts`.

`apps/worker/src/handlers/parse.ts`:
```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { documents, documentPath } from "@ragbench/db";
import type { JobHandler } from "../queue";

export const parseHandler: JobHandler<{ documentId: string }> = async ({ documentId }, { db }) => {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return; // deleted meanwhile — idempotent no-op
  try {
    const raw = await readFile(documentPath(documentId));
    let text: string;
    if (doc.mime === "application/pdf") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(raw));
      const extracted = await extractText(pdf, { mergePages: true });
      text = extracted.text;
    } else {
      text = raw.toString("utf-8");
    }
    const contentHash = createHash("sha256").update(raw).digest("hex");
    await db.update(documents)
      .set({ text, contentHash, status: "ready", error: null })
      .where(eq(documents.id, documentId));
  } catch (err) {
    await db.update(documents)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .where(eq(documents.id, documentId));
  }
};
```

`apps/worker/src/main.ts` — register the handler:
```ts
import { parseHandler } from "./handlers/parse";
// in startWorker handlers object:
handlers: { parse: parseHandler },
```
(Adapt to the file's existing shape; keep the comment listing upcoming handlers.)

- [ ] **Step 5: Run tests** — `pnpm --filter @ragbench/worker test` → PASS. If the hand-rolled PDF fails under unpdf, switch the fixture generator to `pdf-lib` (devDep) and re-commit the fixture.

- [ ] **Step 6: Commit**

```bash
git add apps/worker packages/db && git commit -m "feat: document parse pipeline with pdf and markdown support"
```

---

### Task 6: Chunk + embed jobs (worker)

**Files:**
- Create: `apps/worker/src/handlers/chunk.ts`, `apps/worker/src/handlers/embed.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/worker/test/chunk-embed.test.ts`

**Interfaces:**
- Consumes: `CHUNKERS`, `makeEmbedder`, `toProviderError`, `EMBEDDING_MODELS` (core); `makeUsageReporter` (db); tables.
- Produces:
  - `chunkHandler: JobHandler<{ chunkSetId: string }>` — loads the chunk set, runs its chunker over every `ready` document in the project, inserts `chunks` rows (with `idx` per document). Idempotent: if the set already has chunks, delete-and-recreate inside a transaction (documents may have changed).
  - `embedHandler: JobHandler<{ chunkSetId: string; model: string; organizationId: string }>` — finds the set's chunks lacking a `chunk_embeddings` row for `model`, embeds them in batches of 100 via `makeEmbedder(model, makeUsageReporter(db, organizationId))`, inserts rows with the registry dimension. Skip-existing makes retries cheap. `ProviderError` with `retryable: true` is rethrown (pg-boss retries); non-retryable errors are also rethrown (job fails visibly) — embedding has no owning entity status by design (spec §4 note).
  - Enqueue conventions (Task 8 uses them): queue `"chunk"`, `singletonKey = chunkSetId`; queue `"embed"`, `singletonKey = ${chunkSetId}:${model}`.
  - Registered in `main.ts`: `chunk: chunkHandler, embed: embedHandler`.

- [ ] **Step 1: Write the failing test**

`apps/worker/test/chunk-embed.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  createDb, organizations, projects, documents, chunkSets, chunks, chunkEmbeddings, usageLog,
} from "@ragbench/db";
import { hashParams } from "@ragbench/core";
import { chunkHandler } from "../src/handlers/chunk";
import { embedHandler } from "../src/handlers/embed";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
let ctx: ReturnType<typeof createDb>;
let orgId: string; let projectId: string; let setId: string;

beforeAll(async () => {
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "ce-org" }).returning();
  orgId = org.id;
  const [proj] = await ctx.db.insert(projects).values({ organizationId: orgId, name: "ce-proj" }).returning();
  projectId = proj.id;
  await ctx.db.insert(documents).values({
    projectId, filename: "a.md", mime: "text/markdown", contentHash: "h-a", status: "ready",
    text: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
  });
  await ctx.db.insert(documents).values({
    projectId, filename: "skip.md", mime: "text/markdown", contentHash: "h-s", status: "failed", text: null,
  });
  const params = { maxTokens: 4, overlapTokens: 1 };
  const [set] = await ctx.db.insert(chunkSets).values({
    projectId, chunker: "fixed", params, paramsHash: hashParams(params),
  }).returning();
  setId = set.id;
});
afterAll(async () => { await ctx.pool.end(); });

describe("chunkHandler", () => {
  it("chunks every ready document and skips failed ones", async () => {
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: null as never });
    const rows = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId));
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r.documentId)).size).toBe(1); // only the ready doc
  });

  it("is idempotent (re-run replaces, not duplicates)", async () => {
    const before = (await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId))).length;
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: null as never });
    const after = (await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId))).length;
    expect(after).toBe(before);
  });
});

describe("embedHandler", () => {
  it("embeds all chunks with the mock model and meters usage", async () => {
    await embedHandler({ chunkSetId: setId, model: "mock-embedding", organizationId: orgId }, { db: ctx.db, boss: null as never });
    const chunkRows = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId));
    for (const c of chunkRows) {
      const embs = await ctx.db.select().from(chunkEmbeddings)
        .where(and(eq(chunkEmbeddings.chunkId, c.id), eq(chunkEmbeddings.model, "mock-embedding")));
      expect(embs).toHaveLength(1);
      expect(embs[0].dimension).toBe(256);
    }
    const usage = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    expect(usage.some((u) => u.purpose === "embed" && u.model === "mock-embedding")).toBe(true);
  });

  it("skips already-embedded chunks on retry", async () => {
    const before = (await ctx.db.select().from(chunkEmbeddings)).length;
    await embedHandler({ chunkSetId: setId, model: "mock-embedding", organizationId: orgId }, { db: ctx.db, boss: null as never });
    expect((await ctx.db.select().from(chunkEmbeddings)).length).toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Write the implementation**

`apps/worker/src/handlers/chunk.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { chunkSets, chunks, documents } from "@ragbench/db";
import { CHUNKERS } from "@ragbench/core";
import type { JobHandler } from "../queue";

export const chunkHandler: JobHandler<{ chunkSetId: string }> = async ({ chunkSetId }, { db }) => {
  const [set] = await db.select().from(chunkSets).where(eq(chunkSets.id, chunkSetId));
  if (!set) return;
  const chunker = CHUNKERS[set.chunker];
  if (!chunker) throw new Error(`unknown chunker: ${set.chunker}`);
  const docs = await db.select().from(documents)
    .where(and(eq(documents.projectId, set.projectId), eq(documents.status, "ready")));
  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.chunkSetId, chunkSetId));
    for (const doc of docs) {
      if (!doc.text) continue;
      const pieces = chunker(doc.text, set.params);
      if (pieces.length === 0) continue;
      await tx.insert(chunks).values(pieces.map((p, idx) => ({
        chunkSetId, documentId: doc.id, idx,
        text: p.text, startOffset: p.startOffset, endOffset: p.endOffset,
      })));
    }
  });
};
```

`apps/worker/src/handlers/embed.ts`:
```ts
import { and, eq, notExists } from "drizzle-orm";
import { chunkEmbeddings, chunks, makeUsageReporter } from "@ragbench/db";
import { EMBEDDING_MODELS, makeEmbedder } from "@ragbench/core";
import type { JobHandler } from "../queue";

export const embedHandler: JobHandler<{ chunkSetId: string; model: string; organizationId: string }> =
  async ({ chunkSetId, model, organizationId }, { db }) => {
    const dimension = EMBEDDING_MODELS[model]?.dimension;
    if (!dimension) throw new Error(`unknown embedding model: ${model}`);
    const embedder = makeEmbedder(model, makeUsageReporter(db, organizationId));

    const pending = await db.select().from(chunks).where(and(
      eq(chunks.chunkSetId, chunkSetId),
      notExists(
        db.select().from(chunkEmbeddings).where(and(
          eq(chunkEmbeddings.chunkId, chunks.id),
          eq(chunkEmbeddings.model, model),
        )),
      ),
    ));

    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      const vectors = await embedder.embed(batch.map((c) => c.text));
      await db.insert(chunkEmbeddings)
        .values(batch.map((c, j) => ({ chunkId: c.id, model, dimension, embedding: vectors[j] })))
        .onConflictDoNothing();
    }
  };
```

Register both in `apps/worker/src/main.ts` handlers.

- [ ] **Step 4: Run tests** — `pnpm --filter @ragbench/worker test` → PASS (parse + chunk/embed + existing queue tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker && git commit -m "feat: chunk and embed jobs with idempotent rebuilds and metered batches"
```

---

### Task 7: Upload + documents API (web) with send-only queue client

**Files:**
- Create: `apps/web/src/lib/queue.ts`, `apps/web/src/lib/projects.ts`, `apps/web/src/app/api/projects/[projectId]/documents/route.ts`
- Test: `apps/web/test/documents.test.ts`

**Interfaces:**
- Consumes: `documentPath` (db), auth session, `projects`/`documents` tables.
- Produces:
  - `getBoss(): Promise<PgBoss>` in `lib/queue.ts` — lazy singleton, `new PgBoss(DATABASE_URL)` + `start()`, used ONLY for `createQueue`+`send` (no `work()` in web). Exposes `sendJob(queue: string, data: object, singletonKey: string)` which ensures the queue exists with `policy: "exclusive"` (matching the worker's guard) then sends.
  - `requireProject(projectId, session)` in `lib/projects.ts` → the project row when owned by the session's org, else null. **All later project-scoped routes use this.**
  - `POST /api/projects/:projectId/documents` — multipart `file` field; accepts mimes `application/pdf`, `text/markdown`, `text/plain` (reject others 415); ≤ 20 MB (413); writes bytes to `documentPath(id)`, inserts row (`status: "parsing"`, `contentHash: "pending"`), enqueues `parse` with `singletonKey = documentId` → 201 `{ document }`. 401 unauthenticated, 404 non-owned project.
  - `GET /api/projects/:projectId/documents` → `{ documents: [...] }` without the `text` column (list stays light).
  - Internals exported for tests with injectable session: `listDocuments(projectId, session)`, `uploadDocument(projectId, req, session)`; `uploadDocument` accepts an injectable `send` param defaulting to `sendJob` so tests don't need a running boss.

- [ ] **Step 1: Write the failing test**

`apps/web/test/documents.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { documentPath } from "@ragbench/db";
import { listDocuments, uploadDocument } from "@/app/api/projects/[projectId]/documents/route";
import { registerUser } from "@/lib/signup";
import { createProject } from "@/app/api/projects/route";

let orgId: string; let projectId: string;
const session = () => ({ user: { id: "u", organizationId: orgId } });
const sent: Array<{ queue: string; data: unknown; key: string }> = [];
const fakeSend = async (queue: string, data: object, key: string) => { sent.push({ queue, data, key }); };

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
  const res = await registerUser({ email: `d${Date.now()}@t.dev`, password: "hunter2xx", organizationName: "D" });
  if (res.kind !== "created") throw new Error("signup failed");
  orgId = res.organizationId;
  const createRes = await createProject(new Request("http://t", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Corpus" }),
  }), session() as never);
  projectId = (await createRes.json()).project.id;
});

function uploadReq(name: string, mime: string, body: string) {
  const fd = new FormData();
  fd.set("file", new File([body], name, { type: mime }));
  return new Request("http://t/upload", { method: "POST", body: fd });
}

describe("documents api", () => {
  it("uploads a markdown file, stores it, enqueues parse", async () => {
    const res = await uploadDocument(projectId, uploadReq("notes.md", "text/markdown", "# hi\nbody"), session() as never, fakeSend);
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document.status).toBe("parsing");
    expect(readFileSync(documentPath(document.id), "utf-8")).toContain("# hi");
    expect(sent).toEqual([{ queue: "parse", data: { documentId: document.id }, key: document.id }]);
  });

  it("lists documents without text payloads", async () => {
    const res = await listDocuments(projectId, session() as never);
    const { documents } = await res.json();
    expect(documents.length).toBe(1);
    expect(documents[0]).not.toHaveProperty("text");
  });

  it("rejects unsupported mime types and foreign projects", async () => {
    const bad = await uploadDocument(projectId, uploadReq("x.exe", "application/octet-stream", "MZ"), session() as never, fakeSend);
    expect(bad.status).toBe(415);
    const foreign = await listDocuments(projectId, { user: { id: "u", organizationId: "00000000-0000-0000-0000-000000000000" } } as never);
    expect(foreign.status).toBe(404);
    expect((await uploadDocument(projectId, uploadReq("a.md", "text/markdown", "x"), null as never, fakeSend)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Write the implementation**

`apps/web/src/lib/queue.ts`:
```ts
import PgBoss from "pg-boss";

let boss: PgBoss | null = null;
const ensured = new Set<string>();

async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    boss = new PgBoss(url);
    await boss.start();
  }
  return boss;
}

/** Send-only path. Queues are exclusive-policy (see apps/worker/src/queue.ts): always pass a distinct singletonKey. */
export async function sendJob(queue: string, data: object, singletonKey: string): Promise<void> {
  const b = await getBoss();
  if (!ensured.has(queue)) {
    await b.createQueue(queue, { policy: "exclusive", retryLimit: 3, retryBackoff: true } as never);
    ensured.add(queue);
  }
  await b.send(queue, data, { singletonKey });
}
```
(Match the option-object shape used in `apps/worker/src/queue.ts` exactly.)

`apps/web/src/lib/projects.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { projects } from "@ragbench/db";
import { getDb } from "@/lib/db";
import type { Session } from "next-auth";

export async function requireProject(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return null;
  const [project] = await getDb().select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, session.user.organizationId)));
  return project ?? null;
}
```

`apps/web/src/app/api/projects/[projectId]/documents/route.ts`:
```ts
import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { documents, documentPath } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import { sendJob } from "@/lib/queue";
import type { Session } from "next-auth";

const ALLOWED_MIMES = new Set(["application/pdf", "text/markdown", "text/plain"]);
const MAX_BYTES = 20 * 1024 * 1024;

export async function listDocuments(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rows = await getDb().select({
    id: documents.id, filename: documents.filename, mime: documents.mime,
    status: documents.status, error: documents.error, createdAt: documents.createdAt,
  }).from(documents).where(eq(documents.projectId, projectId));
  return NextResponse.json({ documents: rows });
}

export async function uploadDocument(
  projectId: string, req: Request, session: Session | null,
  send: (queue: string, data: object, key: string) => Promise<void> = sendJob,
) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file field required" }, { status: 400 });
  if (!ALLOWED_MIMES.has(file.type)) return NextResponse.json({ error: `unsupported type: ${file.type}` }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large (max 20MB)" }, { status: 413 });

  const [doc] = await getDb().insert(documents).values({
    projectId, filename: file.name, mime: file.type, contentHash: "pending", status: "parsing",
  }).returning();
  const path = documentPath(doc.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await file.arrayBuffer()));
  await send("parse", { documentId: doc.id }, doc.id);
  return NextResponse.json({ document: doc }, { status: 201 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return listDocuments(projectId, await auth());
}

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return uploadDocument(projectId, req, await auth());
}
```

- [ ] **Step 4: Run tests** — `pnpm --filter @ragbench/web test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat: document upload and listing api with send-only queue client"
```

---

### Task 8: Chunk-set API + corpus page UI + end-to-end smoke

**Files:**
- Create: `apps/web/src/app/api/projects/[projectId]/chunk-sets/route.ts`, `apps/web/src/app/projects/[projectId]/page.tsx`, `apps/web/src/app/projects/[projectId]/corpus-client.tsx`
- Modify: `apps/web/src/app/projects/page.tsx` (link each project to its page)
- Test: `apps/web/test/chunk-sets.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `POST /api/projects/:projectId/chunk-sets` — Zod body `{ chunker: "fixed"|"heading"|"sentence-window", params?: object, embedModel?: string }`; validates `embedModel` against `EMBEDDING_MODELS` (400 unknown); upserts the `chunk_sets` row keyed by `(projectId, chunker, hashParams(params))` (on conflict return existing); enqueues `chunk` (`singletonKey = chunkSetId`) and, when `embedModel` given, `embed` (`singletonKey = ${chunkSetId}:${embedModel}`, data includes `organizationId`) → 201 `{ chunkSet }`. Injectable-session + injectable-send internals `createChunkSet(projectId, req, session, send?)` and `listChunkSets(projectId, session)` (GET returns sets with a chunk count via a grouped count query).
  - Project page `/projects/[id]`: server component guarded by session+ownership (redirect `/login` / notFound), renders `corpus-client.tsx` — a small client component that polls `GET .../documents` and `GET .../chunk-sets` every 2s (SWR-style with `setInterval` + `fetch`; keep it dependency-free), shows a document table (filename, status badge, error) with an upload form (`<input type=file>` posting FormData to the API), and a chunk-set form (chunker select, embed-model select from a hardcoded list `["mock-embedding","text-embedding-3-small","gemini-embedding-001"]`) with a table of existing sets + chunk counts.
  - Styling: keep the existing cool-neutral minimal look; tables with 1px borders, status colored only (green ready / amber parsing / red failed).

- [ ] **Step 1: Write the failing test**

`apps/web/test/chunk-sets.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createChunkSet, listChunkSets } from "@/app/api/projects/[projectId]/chunk-sets/route";
import { registerUser } from "@/lib/signup";
import { createProject } from "@/app/api/projects/route";

let orgId: string; let projectId: string;
const session = () => ({ user: { id: "u", organizationId: orgId } });
const sent: Array<{ queue: string; key: string }> = [];
const fakeSend = async (queue: string, _data: object, key: string) => { sent.push({ queue, key }); };

function req(body: unknown) {
  return new Request("http://t/cs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
  const r = await registerUser({ email: `cs${Date.now()}@t.dev`, password: "hunter2xx", organizationName: "CS" });
  if (r.kind !== "created") throw new Error("signup failed");
  orgId = r.organizationId;
  const pr = await createProject(req({ name: "CS proj" }) as never, session() as never);
  projectId = (await pr.json()).project.id;
});

describe("chunk-sets api", () => {
  it("creates a set and enqueues chunk + embed jobs", async () => {
    const res = await createChunkSet(projectId, req({ chunker: "fixed", params: { maxTokens: 50 }, embedModel: "mock-embedding" }), session() as never, fakeSend);
    expect(res.status).toBe(201);
    const { chunkSet } = await res.json();
    expect(sent.map((s) => s.queue)).toEqual(["chunk", "embed"]);
    expect(sent[1].key).toBe(`${chunkSet.id}:mock-embedding`);
  });

  it("is idempotent on same chunker+params and validates input", async () => {
    const again = await createChunkSet(projectId, req({ chunker: "fixed", params: { maxTokens: 50 } }), session() as never, fakeSend);
    expect(again.status).toBe(200); // existing set returned, no duplicate
    expect((await createChunkSet(projectId, req({ chunker: "nope" }), session() as never, fakeSend)).status).toBe(400);
    expect((await createChunkSet(projectId, req({ chunker: "fixed", embedModel: "nope" }), session() as never, fakeSend)).status).toBe(400);
  });

  it("lists sets with chunk counts and blocks foreign orgs", async () => {
    const list = await listChunkSets(projectId, session() as never);
    const { chunkSets } = await list.json();
    expect(chunkSets).toHaveLength(1);
    expect(chunkSets[0]).toHaveProperty("chunkCount");
    expect((await listChunkSets(projectId, { user: { id: "u", organizationId: "00000000-0000-0000-0000-000000000000" } } as never)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** the route (mirroring Task 7's structure: auth → requireProject → Zod → upsert via `onConflictDoNothing` + re-select on the `(project, chunker, paramsHash)` unique → enqueue via injectable send; GET with `leftJoin`/`count` grouped by set) and the two page files per the interface description. For the upsert: insert with `.onConflictDoNothing().returning()`; when returning is empty, select the existing row and respond 200 instead of 201.

- [ ] **Step 4: Run tests** — `pnpm --filter @ragbench/web test` → PASS; then `pnpm -r test && pnpm -r typecheck` → all green.

- [ ] **Step 5: End-to-end smoke (manual, documented in the report)**

With postgres up: `pnpm db:migrate`, start worker (`DATABASE_URL=...5433... pnpm --filter @ragbench/worker dev` background) and web (`... next dev -p 3300` background). In a browser or via curl with a session cookie: upload `sample.md` fixture to a project → document flips parsing→ready within ~5s; create chunk set (fixed, mock-embedding) → chunk count appears; verify `chunk_embeddings` rows and a nonzero `usage_log` count via psql. Capture the outputs in the task report. Stop the servers.

- [ ] **Step 6: Commit**

```bash
git add apps/web && git commit -m "feat: chunk-set api and corpus page with upload and status polling"
```

---

## Out of scope for this plan

- Test-set generation (plan 3), retrieval/eval (plan 4), attribution (plan 5).
- HTML/Notion ingestion, semantic chunking, document deletion UI (cascade support landed here; UI later).
- Gemini/OpenAI live embedding runs (wiring is done; keys-based smoke is optional and manual).
