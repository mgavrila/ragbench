import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  attributions, chunkEmbeddings, chunkSets, chunks, createDb, documents, evalRuns, organizations, projects,
  questionResults, ragConfigs, testQuestions, testSets, usageLog,
} from "@ragbench/db";
import {
  ProviderError, hashEmbed, hashParams, makeEmbedder, makeLLM, mockExplanation,
} from "@ragbench/core";
import { chunkHandler } from "../src/handlers/chunk";
import { embedHandler } from "../src/handlers/embed";
import { evaluateQuestionHandler } from "../src/handlers/evaluate-question";
import { attributeHandler, type StoredCounterfactuals } from "../src/handlers/attribute";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
let ctx: ReturnType<typeof createDb>;

// pg-boss stand-in: this handler never enqueues, but the context type demands one.
const boss = { async send() { return "job-1"; } } as never;

// ---------------------------------------------------------------------------
// Fixtures
//
// mock-embedding is hashEmbed, a bag-of-tokens hash, so cosine similarity between a question and a
// chunk is exact arithmetic over their shared tokens: dot(Q,C) / (sqrt(|Q|) * sqrt(|C|)) counting
// token occurrences. Every text below is a disjoint keyword bag written to put the gold chunk at a
// KNOWN rank in the full ordering, which is what lets these tests assert bestGoldRank to the digit.
// The numbers in each test's comment were computed from that formula and confirmed against
// hashEmbed itself (no two tokens in this corpus collide at dim 256 or 1536, so no accidental
// similarity leaks in).
// ---------------------------------------------------------------------------

/** Gold ("beta gamma") is cut by the token boundary in the fixed set but sits inside one heading section. */
const DOC_ROOTS = "# roots\nalpha beta gamma delta epsilon\n# shoots\nzeta eta";
/** Five two-token decoys sharing one token with the straddle question -- they outrank both gold chunks. */
const DOC_CROWNS = ["crown regalia", "crown diadem", "crown tiara", "crown fillet", "crown coronet"];
/** Gold ("water table") is this whole document, so it is intact in every chunk set. */
const DOC_HYDRO = "water table";
/** Five three-token decoys sharing two tokens with the hydro questions -- gold lands at rank 6. */
const DOC_PUMPS = [
  "pump valve nozzle", "pump valve gasket", "pump valve flange", "pump valve spindle",
  "pump valve bracket",
];
/** Gold ("sigma tau") is intact here, and exactly one decoy outranks it -- a rank-2 near miss. */
const DOC_NEAR = "sigma tau upsilon";
const DOC_QUILL = "quill sigma";
/** Added AFTER every chunk set was built, so no set has a chunk covering its gold span. */
const DOC_ORPHAN = "orphan lexicon";

const FIXED_PARAMS = { maxTokens: 4, overlapTokens: 0 };
const HEADING_PARAMS = { maxChars: 4000 };
const SENTENCE_PARAMS = { windowSentences: 2, overlapSentences: 0 };

/** Total chunks in the fixed set: roots 3 + crowns 5 + hydro 1 + pumps 5 + near 1 + quill 1. */
const FIXED_SET_CHUNKS = 16;

const ALT_MODEL = "text-embedding-3-small";
const UNEMBEDDED_MODEL = "gemini-embedding-001";

/**
 * The alternate embedder: hashEmbed over a synonym-canonicalised copy of the text. It ranks
 * identically to mock-embedding on every fixture EXCEPT one whose question says "hydro" where the
 * gold chunk says "water" -- that question is the only one a different embedder recovers, which is
 * exactly the situation the embedder counterfactual exists to detect. Keyless, deterministic, and
 * injected through the handler's factory seam; the real text-embedding-3-small needs an API key.
 */
const SYNONYMS: Record<string, string> = { hydro: "water" };
function altEmbed(text: string): number[] {
  return hashEmbed(text.replace(/[a-z]+/gi, (w) => SYNONYMS[w.toLowerCase()] ?? w), 1536);
}
const altFactory: typeof makeEmbedder = (model, report) => {
  if (model !== ALT_MODEL) return makeEmbedder(model, report);
  return {
    model: ALT_MODEL,
    dimension: 1536,
    async embed(texts: string[]): Promise<number[][]> {
      await report?.({
        purpose: "embed", provider: "openai", model: ALT_MODEL,
        inputTokens: texts.reduce((n, t) => n + t.split(/\s+/).length, 0), outputTokens: 0,
      });
      return texts.map(altEmbed);
    },
  };
};

let orgId: string;
let projectId: string;
let testSetId: string;
let fixedSetId: string;
let headingSetId: string;
let sentenceSetId: string;
let rootsChunkIds: string[];
const q: Record<string, string> = {};
let configSeq = 0;

/** Gold span of a quote inside a document, as the offsets a test question stores. */
function goldSpan(text: string, quote: string) {
  const goldStart = text.indexOf(quote);
  if (goldStart < 0) throw new Error(`fixture quote not found: ${quote}`);
  return { goldStart, goldEnd: goldStart + quote.length, goldAnswer: quote };
}

async function insertDoc(filename: string, text: string): Promise<string> {
  const [doc] = await ctx.db.insert(documents).values({
    projectId, filename, mime: "text/markdown", contentHash: `attr-${filename}`,
    status: "ready", text,
  }).returning();
  return doc.id;
}

beforeAll(async () => {
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "attr-org" }).returning();
  orgId = org.id;
  const [project] = await ctx.db.insert(projects)
    .values({ organizationId: orgId, name: "attr-proj" }).returning();
  projectId = project.id;

  const rootsDoc = await insertDoc("roots.md", DOC_ROOTS);
  const hydroDoc = await insertDoc("hydro.md", DOC_HYDRO);
  const nearDoc = await insertDoc("near.md", DOC_NEAR);
  await insertDoc("quill.md", DOC_QUILL);
  for (const [i, text] of DOC_CROWNS.entries()) await insertDoc(`crown-${i}.md`, text);
  for (const [i, text] of DOC_PUMPS.entries()) await insertDoc(`pump-${i}.md`, text);

  const newSet = async (chunker: string, params: Record<string, unknown>, embedModels: string[]) => {
    const [set] = await ctx.db.insert(chunkSets).values({
      projectId, chunker, params, paramsHash: hashParams(params), embedModels,
    }).returning();
    return set.id;
  };
  // The config's own set, an alternate chunker (the chunker counterfactual), and a third set that
  // is chunked but never embedded (which must be REPORTED as skipped, never embedded on the fly).
  fixedSetId = await newSet("fixed", FIXED_PARAMS, ["mock-embedding", ALT_MODEL, UNEMBEDDED_MODEL]);
  headingSetId = await newSet("heading", HEADING_PARAMS, ["mock-embedding"]);
  sentenceSetId = await newSet("sentence-window", SENTENCE_PARAMS, ["mock-embedding"]);

  // Chunks and embeddings come from the real handlers, so these tests diagnose a corpus the
  // pipeline actually produced rather than vectors hand-written to make the assertions pass.
  for (const setId of [fixedSetId, headingSetId, sentenceSetId]) {
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss });
  }
  for (const [setId, model] of [
    [fixedSetId, "mock-embedding"], [fixedSetId, ALT_MODEL], [headingSetId, "mock-embedding"],
  ] as const) {
    await embedHandler({ chunkSetId: setId, model, organizationId: orgId }, { db: ctx.db, boss }, altFactory);
  }

  // Inserted after the sets were built: nothing re-chunks, so this document has no chunks anywhere.
  const orphanDoc = await insertDoc("orphan.md", DOC_ORPHAN);

  rootsChunkIds = (await ctx.db.select().from(chunks)
    .where(and(eq(chunks.chunkSetId, fixedSetId), eq(chunks.documentId, rootsDoc)))
    .orderBy(chunks.idx)).map((c) => c.id);

  const [tset] = await ctx.db.insert(testSets).values({
    projectId, name: "attr-set", generatorModel: "mock-llm", status: "ready",
  }).returning();
  testSetId = tset.id;

  const questions = await ctx.db.insert(testQuestions).values([
    // Gold straddles the fixed set's first boundary; 5 crown decoys (0.408) outrank both halves
    // (0.333 each), so gold's best rank is 6.
    { testSetId, documentId: rootsDoc, question: "beta gamma crown", ...goldSpan(DOC_ROOTS, "beta gamma") },
    // Gold is intact in one chunk but 5 pump decoys (0.577) outrank it (0.354): rank 6. "brine" is
    // not in the synonym map, so the alternate embedder ranks it identically -- nothing recovers it.
    { testSetId, documentId: hydroDoc, question: "brine table pump valve", ...goldSpan(DOC_HYDRO, "water table") },
    // Same corpus position, but "hydro" canonicalises to "water": the alternate embedder pulls gold
    // to rank 1 while mock-embedding still ranks it 6.
    { testSetId, documentId: hydroDoc, question: "hydro table pump valve", ...goldSpan(DOC_HYDRO, "water table") },
    // One decoy (0.816) outranks gold (0.667): rank 2, one place outside a top-1 cutoff.
    { testSetId, documentId: nearDoc, question: "sigma tau quill", ...goldSpan(DOC_NEAR, "sigma tau") },
    // Gold lives in a document no chunk set covers, and its vocabulary appears nowhere else.
    { testSetId, documentId: orphanDoc, question: "orphan lexicon", ...goldSpan(DOC_ORPHAN, "orphan") },
  ]).returning();
  for (const [i, key] of ["straddle", "intact", "embedder", "near", "orphan"].entries()) {
    q[key] = questions[i].id;
  }
});

afterAll(async () => { await ctx.pool.end(); });

/**
 * A real question_results row for one question, produced by the real evaluator, under a fresh run
 * and config so each test owns its own result (an attribution is one-per-result, and re-diagnosing
 * an already-diagnosed result is a no-op by design).
 */
async function freshResult(
  questionId: string,
  opts: { topK?: number; judgeModel?: string | null } = {},
): Promise<typeof questionResults.$inferSelect> {
  const [config] = await ctx.db.insert(ragConfigs).values({
    projectId, name: `attr-cfg-${configSeq++}`, chunkSetId: fixedSetId,
    embeddingModel: "mock-embedding", topK: opts.topK ?? 1,
  }).returning();
  const [run] = await ctx.db.insert(evalRuns).values({
    projectId, testSetId, mode: "retrieval-only",
    judgeModel: opts.judgeModel === undefined ? "mock-llm" : opts.judgeModel,
  }).returning();
  await evaluateQuestionHandler(
    { runId: run.id, configId: config.id, questionId, organizationId: orgId },
    { db: ctx.db, boss },
  );
  const [row] = await ctx.db.select().from(questionResults).where(and(
    eq(questionResults.runId, run.id),
    eq(questionResults.configId, config.id),
    eq(questionResults.questionId, questionId),
  ));
  return row;
}

function diagnose(resultId: string, llm: typeof makeLLM = makeLLM, embedder: typeof makeEmbedder = altFactory) {
  return attributeHandler({ resultId, organizationId: orgId }, { db: ctx.db, boss }, embedder, llm);
}

async function attributionFor(resultId: string) {
  const [row] = await ctx.db.select().from(attributions).where(eq(attributions.resultId, resultId));
  return row;
}

/** The stored jsonb, typed. `counterfactuals` is an untyped jsonb column on the table. */
function stored(row: { counterfactuals: unknown }): StoredCounterfactuals {
  return row.counterfactuals as StoredCounterfactuals;
}

function cellsOf(cf: StoredCounterfactuals, kind: "chunker" | "embedder" | "topk") {
  return cf.matrix.filter((c) => c.kind === kind);
}

const headingLabel = () => `heading (${hashParams(HEADING_PARAMS).slice(0, 8)})`;
const sentenceLabel = () => `sentence-window (${hashParams(SENTENCE_PARAMS).slice(0, 8)})`;

describe("attributeHandler verdicts", () => {
  it("blames chunking when the gold span straddles a boundary and another chunker recovers it", async () => {
    const result = await freshResult(q.straddle);
    expect(result.hit).toBe(false); // a genuine miss, not a fixture that accidentally succeeded

    await diagnose(result.id);
    const row = await attributionFor(result.id);
    const cf = stored(row);

    expect(row.verdict).toBe("chunking");
    expect(cf.rule).toBe("gold-straddles-chunks");
    expect(cf.signals).toEqual({ goldInSingleChunk: false, bestGoldRank: 6, k: 1 });

    // The heading set keeps the span whole in one short section, which outranks the decoys there.
    expect(cellsOf(cf, "chunker")).toEqual([
      { kind: "chunker", label: headingLabel(), hit: true, rank: 1 },
    ]);
    // Nothing else recovers it: the same embedder at 2x/4x depth still returns crown decoys, and
    // the alternate embedder ranks this question exactly as the original one did.
    expect(cellsOf(cf, "topk")).toEqual([
      { kind: "topk", label: "k=2", hit: false, rank: null },
      { kind: "topk", label: "k=4", hit: false, rank: null },
    ]);
    expect(cellsOf(cf, "embedder")).toEqual([
      { kind: "embedder", label: ALT_MODEL, hit: false, rank: null },
    ]);

    // Evidence = both halves of the split gold span, then what the run actually retrieved.
    expect(row.evidenceChunkIds?.slice(0, 2)).toEqual(rootsChunkIds.slice(0, 2));
    expect(row.evidenceChunkIds).toHaveLength(3);
  });

  it("blames embedding when the gold chunk is intact but ranked far outside k", async () => {
    const result = await freshResult(q.intact);
    await diagnose(result.id);
    const cf = stored(await attributionFor(result.id));

    expect((await attributionFor(result.id)).verdict).toBe("embedding");
    expect(cf.rule).toBe("gold-intact-not-ranked");
    expect(cf.signals).toEqual({ goldInSingleChunk: true, bestGoldRank: 6, k: 1 });
    // Every counterfactual misses -- rank 6 is out of reach at k=4, the heading set chunks this
    // one-line document identically, and the alternate embedder has no synonym to exploit here.
    expect(cf.matrix.every((c) => !c.hit)).toBe(true);
    expect(cf.matrix).toHaveLength(4);
  });

  it("blames embedding when a different embedder recovers the same intact chunk", async () => {
    const result = await freshResult(q.embedder);
    await diagnose(result.id);
    const row = await attributionFor(result.id);
    const cf = stored(row);

    expect(row.verdict).toBe("embedding");
    expect(cf.rule).toBe("embedder-counterfactual-hits");
    expect(cf.signals).toEqual({ goldInSingleChunk: true, bestGoldRank: 6, k: 1 });
    expect(cellsOf(cf, "embedder")).toEqual([
      { kind: "embedder", label: ALT_MODEL, hit: true, rank: 1 },
    ]);
    expect(cellsOf(cf, "chunker")[0].hit).toBe(false);
  });

  it("blames retrieval depth when gold sits just outside k and a deeper cutoff finds it", async () => {
    const result = await freshResult(q.near);
    await diagnose(result.id);
    const row = await attributionFor(result.id);
    const cf = stored(row);

    expect(row.verdict).toBe("retrieval");
    expect(cf.rule).toBe("topk-recovers");
    expect(cf.signals).toEqual({ goldInSingleChunk: true, bestGoldRank: 2, k: 1 });
    expect(cellsOf(cf, "topk")).toEqual([
      { kind: "topk", label: "k=2", hit: true, rank: 2 },
      { kind: "topk", label: "k=4", hit: true, rank: 2 },
    ]);
  });

  it("calls the question unanswerable when no chunk anywhere covers the gold span", async () => {
    const result = await freshResult(q.orphan);
    await diagnose(result.id);
    const row = await attributionFor(result.id);
    const cf = stored(row);

    expect(row.verdict).toBe("unanswerable");
    expect(cf.rule).toBe("nothing-hits");
    // No chunk overlaps gold at all, which is the one case that must not be read as a straddle.
    expect(cf.signals).toEqual({ goldInSingleChunk: false, bestGoldRank: null, k: 1 });
    expect(cf.matrix.every((c) => !c.hit && c.rank === null)).toBe(true);
    // No gold-overlapping chunk exists, so the evidence is only what the run retrieved.
    expect(row.evidenceChunkIds).toHaveLength(1);
  });

  it("diagnoses a result that hit, not just a miss", async () => {
    // topK 8 puts the rank-6 gold chunk inside the cutoff, so the run succeeded -- the handler is
    // still expected to answer, and the straddle is still what the evidence shows.
    const result = await freshResult(q.straddle, { topK: 8 });
    expect(result.hit).toBe(true);

    await diagnose(result.id);
    const row = await attributionFor(result.id);
    const cf = stored(row);
    expect(row.verdict).toBe("chunking");
    expect(cf.signals).toEqual({ goldInSingleChunk: false, bestGoldRank: 6, k: 8 });
  });
});

describe("attributeHandler counterfactual matrix", () => {
  it("reports pairs it will not embed instead of embedding them", async () => {
    const result = await freshResult(q.intact);
    const embeddingsBefore = await ctx.db.select().from(usageLog)
      .where(eq(usageLog.organizationId, orgId));

    await diagnose(result.id);
    const cf = stored(await attributionFor(result.id));

    // A chunk set with no vectors for this model, and a model the set was asked for but never got.
    expect(cf.skipped).toContain(`chunker "${sentenceLabel()}": not embedded with mock-embedding`);
    expect(cf.skipped).toContain(`embedder "${UNEMBEDDED_MODEL}": requested for this chunk set but not embedded yet`);
    // Skipped means skipped: the missing pairs are absent from the matrix, not recorded as misses.
    expect(cf.matrix.some((c) => c.label === sentenceLabel() || c.label === UNEMBEDDED_MODEL)).toBe(false);

    // And nothing was embedded to fill them in: the only new spend is this job's two query embeds
    // (the config's model and the one alternate model that already had vectors), and the chunk set
    // that was reported skipped still has no vectors at all.
    const after = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    const added = after.filter((u) => !embeddingsBefore.some((b) => b.id === u.id));
    expect(added.filter((u) => u.purpose === "attribution" && u.outputTokens === 0)).toHaveLength(2);
    const sentenceVectors = await ctx.db.select({ id: chunkEmbeddings.id })
      .from(chunkEmbeddings)
      .innerJoin(chunks, eq(chunkEmbeddings.chunkId, chunks.id))
      .where(eq(chunks.chunkSetId, sentenceSetId));
    expect(sentenceVectors).toEqual([]);
  });

  it("clamps a deeper cutoff to the set size and skips the duplicate cell", async () => {
    // topK 8 in a 16-chunk set: 2x is a real 16-chunk retrieval, 4x (32) would return the same 16
    // rows, so it is reported as skipped rather than filling the matrix with a duplicate.
    const result = await freshResult(q.straddle, { topK: 8 });
    await diagnose(result.id);
    const cf = stored(await attributionFor(result.id));

    expect(cellsOf(cf, "topk")).toEqual([
      { kind: "topk", label: "k=16", hit: true, rank: 6 },
    ]);
    expect(cf.skipped).toContain(
      `k=32: only ${FIXED_SET_CHUNKS} chunk(s) are retrievable here, so it retrieves the same rows as k=16`,
    );
  });

  it("skips an alternate embedder that cannot be called instead of failing the diagnosis", async () => {
    const failingAlt: typeof makeEmbedder = (model, report) => {
      if (model !== ALT_MODEL) return makeEmbedder(model, report);
      return {
        model: ALT_MODEL, dimension: 1536,
        async embed(): Promise<number[][]> {
          throw new ProviderError("auth", "openai", "no credentials for openai");
        },
      };
    };
    const result = await freshResult(q.intact);
    await expect(diagnose(result.id, makeLLM, failingAlt)).resolves.toBeUndefined();

    const row = await attributionFor(result.id);
    const cf = stored(row);
    // The verdict never depended on that cell, so it is still computed and stored.
    expect(row.verdict).toBe("embedding");
    expect(cellsOf(cf, "embedder")).toEqual([]);
    expect(cf.skipped).toContain(`embedder "${ALT_MODEL}": no credentials for openai`);
  });
});

describe("attributeHandler explanation", () => {
  it("uses the deterministic template and meters it when the judge model is the mock", async () => {
    const result = await freshResult(q.near);
    await diagnose(result.id);
    const row = await attributionFor(result.id);
    const cf = stored(row);

    expect(row.explanation).toBe(mockExplanation("retrieval", cf.signals));

    const usage = await ctx.db.select().from(usageLog).where(and(
      eq(usageLog.organizationId, orgId), eq(usageLog.purpose, "attribution"),
    ));
    const explained = usage.filter((u) => u.model === "mock-llm");
    expect(explained.length).toBeGreaterThan(0);
    // Synthetic but real counts at zero cost -- not a row of zeroes.
    expect(explained.every((u) => u.inputTokens > 0 && u.outputTokens > 0 && u.costUsd === 0)).toBe(true);
    // Query embeds for both the config's model and the alternate one are metered here too, so a
    // diagnose shows up in the ledger as one purpose rather than leaking into "embed".
    expect(usage.some((u) => u.model === "mock-embedding")).toBe(true);
    expect(usage.some((u) => u.model === ALT_MODEL)).toBe(true);
  });

  it("asks a real judge model to explain the verdict it was given, and stores the reply", async () => {
    const prompts: string[] = [];
    const scripted: typeof makeLLM = () => ({
      model: "scripted",
      async complete({ prompt }: { prompt: string }): Promise<string> {
        prompts.push(prompt);
        return "The gold text was split in half by a chunk boundary.";
      },
    });
    const result = await freshResult(q.straddle, { judgeModel: "claude-opus-5" });
    await diagnose(result.id, scripted);

    const row = await attributionFor(result.id);
    expect(row.explanation).toBe("The gold text was split in half by a chunk boundary.");
    expect(prompts).toHaveLength(1);
    // The prompt carries the already-decided verdict and the evidence behind it: the model explains,
    // it never diagnoses.
    expect(prompts[0]).toContain("beta gamma crown");
    expect(prompts[0]).toContain("Verdict: chunking");
    expect(prompts[0]).toContain(headingLabel());
  });

  it("stores the verdict with a null explanation when the explaining model fails", async () => {
    const poisonedLLM = (err: Error): typeof makeLLM => () => ({
      model: "poison",
      async complete(): Promise<string> { throw err; },
    });
    // Fail-open for BOTH provider failure classes: the verdict is already decided from measured
    // evidence, and retrying the whole job would re-run every counterfactual retrieval just to
    // re-ask for prose.
    for (const err of [
      new ProviderError("auth", "anthropic", "key rejected"),
      new ProviderError("rate_limit", "anthropic", "slow down"),
    ]) {
      const result = await freshResult(q.near, { judgeModel: "claude-opus-5" });
      await expect(diagnose(result.id, poisonedLLM(err))).resolves.toBeUndefined();
      const row = await attributionFor(result.id);
      expect(row.verdict).toBe("retrieval");
      expect(row.explanation).toBeNull();
      expect(stored(row).matrix.length).toBeGreaterThan(0);
    }
  });

  it("propagates a non-provider failure from the explaining model", async () => {
    const bug = new TypeError("undefined is not a function");
    const buggyLLM: typeof makeLLM = () => ({
      model: "buggy",
      async complete(): Promise<string> { throw bug; },
    });
    const result = await freshResult(q.near, { judgeModel: "claude-opus-5" });
    await expect(diagnose(result.id, buggyLLM)).rejects.toThrow(bug);
    expect(await attributionFor(result.id)).toBeUndefined();
  });

  it("stores a verdict with no explanation when the run pinned no judge model", async () => {
    const result = await freshResult(q.near, { judgeModel: null });
    await diagnose(result.id);
    const row = await attributionFor(result.id);
    expect(row.verdict).toBe("retrieval");
    expect(row.explanation).toBeNull();
  });
});

describe("attributeHandler failure and idempotency", () => {
  const poisonedEmbedder = (err: Error): typeof makeEmbedder => () => ({
    model: "poison", dimension: 3,
    async embed(): Promise<number[][]> { throw err; },
  });

  it("is idempotent: a re-delivered job neither duplicates the row nor pays twice", async () => {
    const result = await freshResult(q.intact);
    await diagnose(result.id);
    const before = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));

    await diagnose(result.id);

    const rows = await ctx.db.select().from(attributions).where(eq(attributions.resultId, result.id));
    expect(rows).toHaveLength(1);
    const after = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    expect(after).toHaveLength(before.length);
  });

  it("no-ops on a result that does not exist", async () => {
    await expect(attributeHandler(
      { resultId: "00000000-0000-0000-0000-000000000000", organizationId: orgId },
      { db: ctx.db, boss },
    )).resolves.toBeUndefined();
    expect(await ctx.db.select().from(attributions)
      .where(eq(attributions.resultId, "00000000-0000-0000-0000-000000000000"))).toEqual([]);
  });

  it("logs and writes nothing when the query embedding fails non-retryably", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await freshResult(q.intact);
      await expect(diagnose(
        result.id, makeLLM, poisonedEmbedder(new ProviderError("auth", "poison", "no credentials")),
      )).resolves.toBeUndefined();

      // No row and no throw: there is no failed-attribution state to record, and pg-boss retrying a
      // key that can never work would only lose the job. The user can click Diagnose again.
      expect(await attributionFor(result.id)).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("no credentials"));
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows a retryable query-embedding failure and writes nothing, leaving it to pg-boss", async () => {
    const result = await freshResult(q.intact);
    await expect(diagnose(
      result.id, makeLLM, poisonedEmbedder(new ProviderError("rate_limit", "poison", "slow down")),
    )).rejects.toThrow("slow down");
    expect(await attributionFor(result.id)).toBeUndefined();
  });

  it("propagates a failure that is not a ProviderError untouched", async () => {
    const result = await freshResult(q.intact);
    const bug = new TypeError("undefined is not a function");
    await expect(diagnose(result.id, makeLLM, poisonedEmbedder(bug))).rejects.toThrow(bug);
    expect(await attributionFor(result.id)).toBeUndefined();
  });
});
