import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDb, organizations, projects, documents, chunkSets, chunks, evalRunConfigs, evalRuns,
  questionResults, ragConfigs, testQuestions, testSets, usageLog,
} from "@ragbench/db";
import { ProviderError, hashParams, makeEmbedder, makeLLM } from "@ragbench/core";
import { chunkHandler } from "../src/handlers/chunk";
import { embedHandler } from "../src/handlers/embed";
import { startRunHandler } from "../src/handlers/start-run";
import { evaluateQuestionHandler } from "../src/handlers/evaluate-question";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
let ctx: ReturnType<typeof createDb>;

// The mock embedder is a bag-of-tokens hash (hashEmbed), so cosine similarity is just the overlap
// of distinct words between a question and a chunk. Every fixture below is written as a keyword bag
// with deliberately disjoint vocabulary per chunk, which makes the ranking exact arithmetic rather
// than a guess: a query sharing 4 of 6 words with a chunk scores 4/6, sharing 2 scores 2/6, sharing
// none scores 0. That is what lets these tests assert reciprocal rank to the digit.
const CHUNK_TEXTS = [
  "volcano magma erupts through basalt fissures",
  "photosynthesis chloroplast converts sunlight into glucose",
  "kangaroo marsupial hops across queensland grasslands",
] as const;
const DOC_TEXT = CHUNK_TEXTS.join(" ");
// A second document in the same chunk set: its vocabulary is disjoint from every question below, so
// it scores 0 and never enters a top-k. It is here to prove retrieval ranks across the whole set
// (and that the chunk-set filter does not leak) rather than trivially over one document.
const OTHER_DOC_TEXT = "tidal estuary sediment deposits accumulate slowly beneath mangrove roots";

// Six words per chunk with no overlap makes each fixture line above exactly one chunk, with
// disjoint spans -- so a gold span taken from one chunk cannot accidentally overlap its neighbour.
const CHUNK_PARAMS = { maxTokens: 6, overlapTokens: 0 };

let orgId: string;
let projectId: string;
let docId: string;
let setId: string;
let testSetId: string;
/** The three fixture chunks of `docId`, ordered by idx: [volcano, photosynthesis, kangaroo]. */
let fixtureChunks: Array<{ id: string; text: string; startOffset: number; endOffset: number }>;
/** Question ids, one per scenario. */
let qHit: string; let qSecond: string; let qMiss: string;

type SentJob = { name: string; data: unknown; opts: unknown };
const sentJobs: SentJob[] = [];
const recordingBoss = {
  async send(name: string, data: unknown, opts: unknown) {
    sentJobs.push({ name, data, opts });
    return "job-1";
  },
} as never;

/** The payload shape start-run fans out; narrowed from the recording boss's `unknown` data. */
type EvalJob = { runId: string; configId: string; questionId: string; organizationId: string };
function evalJobs(): EvalJob[] {
  return sentJobs
    .filter((j) => j.name === "evaluate-question")
    .map((j) => j.data as EvalJob);
}

async function makeRun(mode: string, extra: { judgeModel?: string; answerModel?: string } = {}) {
  const [run] = await ctx.db.insert(evalRuns)
    .values({ projectId, testSetId, mode, ...extra })
    .returning();
  return run;
}

async function resultFor(runId: string, configId: string, questionId: string) {
  const [row] = await ctx.db.select().from(questionResults).where(and(
    eq(questionResults.runId, runId),
    eq(questionResults.configId, configId),
    eq(questionResults.questionId, questionId),
  ));
  return row;
}

beforeAll(async () => {
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "eval-org" }).returning();
  orgId = org.id;
  const [project] = await ctx.db.insert(projects)
    .values({ organizationId: orgId, name: "eval-proj" }).returning();
  projectId = project.id;

  const [doc] = await ctx.db.insert(documents).values({
    projectId, filename: "science.md", mime: "text/markdown", contentHash: "eval-h1",
    status: "ready", text: DOC_TEXT,
  }).returning();
  docId = doc.id;
  await ctx.db.insert(documents).values({
    projectId, filename: "estuary.md", mime: "text/markdown", contentHash: "eval-h2",
    status: "ready", text: OTHER_DOC_TEXT,
  });

  const [set] = await ctx.db.insert(chunkSets).values({
    projectId, chunker: "fixed", params: CHUNK_PARAMS, paramsHash: hashParams(CHUNK_PARAMS),
  }).returning();
  setId = set.id;

  // Chunks and embeddings come from the real handlers: this suite is the end-to-end proof that a
  // corpus built by the pipeline is retrievable by the evaluator, so seeding vectors by hand would
  // test the wrong thing.
  await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: recordingBoss });
  await embedHandler(
    { chunkSetId: setId, model: "mock-embedding", organizationId: orgId },
    { db: ctx.db, boss: recordingBoss },
  );

  fixtureChunks = (await ctx.db.select().from(chunks)
    .where(and(eq(chunks.chunkSetId, setId), eq(chunks.documentId, docId)))
    .orderBy(chunks.idx))
    .map((c) => ({ id: c.id, text: c.text, startOffset: c.startOffset, endOffset: c.endOffset }));

  const [tset] = await ctx.db.insert(testSets).values({
    projectId, name: "eval-set", generatorModel: "mock-llm", status: "ready",
  }).returning();
  testSetId = tset.id;

  // Questions are seeded directly (not generated) so their gold spans are known exactly: each one's
  // span is a whole fixture chunk, and its gold answer is that chunk's text.
  const gold = (i: number) => ({
    documentId: docId,
    goldAnswer: fixtureChunks[i].text,
    goldStart: fixtureChunks[i].startOffset,
    goldEnd: fixtureChunks[i].endOffset,
  });
  const inserted = await ctx.db.insert(testQuestions).values([
    // Query is chunk 1 verbatim -> chunk 1 ranks first (cosine 1.0); gold is chunk 1 -> rr 1.
    { testSetId, question: CHUNK_TEXTS[1], ...gold(1) },
    // Query shares 4 words with chunk 1 (score 4/6) and 2 with chunk 0 (score 2/6), nothing else:
    // ranking is [chunk 1, chunk 0]. Gold is chunk 0 -> hit at rank 2 -> rr 0.5.
    { testSetId, question: "photosynthesis chloroplast converts sunlight volcano magma", ...gold(0) },
    // Same ranking as above, but gold is chunk 2, which no top-2 result overlaps -> miss.
    { testSetId, question: "photosynthesis chloroplast converts sunlight volcano magma", ...gold(2) },
  ]).returning();
  [qHit, qSecond, qMiss] = inserted.map((q) => q.id);
});

afterAll(async () => { await ctx.pool.end(); });

describe("startRunHandler", () => {
  it("fans out one job per config x question with distinct singleton keys and counts totalJobs", async () => {
    const [cfgA] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "top2", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const [cfgB] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "top1", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 1,
    }).returning();
    const run = await makeRun("retrieval-only");
    await ctx.db.insert(evalRunConfigs).values([
      { runId: run.id, configId: cfgA.id }, { runId: run.id, configId: cfgB.id },
    ]);

    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });

    const jobs = evalJobs();
    expect(jobs).toHaveLength(6); // 2 configs x 3 questions
    expect(new Set(sentJobs.map((j) => (j.opts as { singletonKey: string }).singletonKey)).size).toBe(6);
    expect(sentJobs.every((j) =>
      (j.opts as { singletonKey: string }).singletonKey.startsWith(`${run.id}:`))).toBe(true);
    expect(jobs.every((j) => j.organizationId === orgId)).toBe(true);

    const [after] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, run.id));
    expect(after.status).toBe("running");
    expect(after.totalJobs).toBe(6);
  });

  it("fails the run, naming the config, when a config's chunk set has no embeddings for its model", async () => {
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      // The set is embedded with mock-embedding only, so this config can never retrieve anything.
      projectId, name: "unembedded", chunkSetId: setId, embeddingModel: "text-embedding-3-small", topK: 3,
    }).returning();
    const run = await makeRun("retrieval-only");
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });

    sentJobs.length = 0;
    await expect(startRunHandler(
      { runId: run.id, organizationId: orgId },
      { db: ctx.db, boss: recordingBoss },
    )).resolves.toBeUndefined();

    expect(evalJobs()).toHaveLength(0);
    const [after] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, run.id));
    expect(after.status).toBe("failed");
    expect(after.error).toContain("unembedded");
    expect(after.error).toContain("text-embedding-3-small");
  });

  it("fails the run, naming the config and the value, when a config's topK is below 1", async () => {
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "zero-k", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 0,
    }).returning();
    const run = await makeRun("retrieval-only");
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });

    sentJobs.length = 0;
    await expect(startRunHandler(
      { runId: run.id, organizationId: orgId },
      { db: ctx.db, boss: recordingBoss },
    )).resolves.toBeUndefined();

    expect(evalJobs()).toHaveLength(0);
    const [after] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, run.id));
    expect(after.status).toBe("failed");
    expect(after.error).toContain("zero-k");
    expect(after.error).toContain("topK 0");
  });

  it("no-ops on a missing, done or cancelled run", async () => {
    const done = await makeRun("retrieval-only");
    await ctx.db.update(evalRuns).set({ status: "done" }).where(eq(evalRuns.id, done.id));
    const cancelled = await makeRun("retrieval-only");
    await ctx.db.update(evalRuns).set({ status: "cancelled" }).where(eq(evalRuns.id, cancelled.id));

    sentJobs.length = 0;
    await startRunHandler({ runId: done.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    await startRunHandler({ runId: cancelled.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    await startRunHandler(
      { runId: "00000000-0000-0000-0000-000000000000", organizationId: orgId },
      { db: ctx.db, boss: recordingBoss },
    );
    expect(sentJobs).toEqual([]);

    const [stillDone] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, done.id));
    expect(stillDone.status).toBe("done");
    expect(stillDone.totalJobs).toBe(0);
  });

  it("fails the run when it has no configs or its test set has no active questions", async () => {
    const noConfigs = await makeRun("retrieval-only");
    await startRunHandler({ runId: noConfigs.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    const [a] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, noConfigs.id));
    expect(a.status).toBe("failed");
    expect(a.error).toContain("no configs");

    const [emptySet] = await ctx.db.insert(testSets).values({
      projectId, name: "empty-set", generatorModel: "mock-llm", status: "ready",
    }).returning();
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "cfg-empty", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const [noQuestions] = await ctx.db.insert(evalRuns)
      .values({ projectId, testSetId: emptySet.id, mode: "retrieval-only" }).returning();
    await ctx.db.insert(evalRunConfigs).values({ runId: noQuestions.id, configId: cfg.id });

    await startRunHandler({ runId: noQuestions.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    const [b] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, noQuestions.id));
    expect(b.status).toBe("failed");
    expect(b.error).toContain("no active questions");
  });
});

describe("evaluateQuestionHandler (retrieval-only)", () => {
  it("evaluates every fanned-out job: spans score hit/rr, and the run completes", async () => {
    const [cfg2] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "r-top2", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const [cfg1] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "r-top1", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 1,
    }).returning();
    const run = await makeRun("retrieval-only");
    await ctx.db.insert(evalRunConfigs).values([
      { runId: run.id, configId: cfg2.id }, { runId: run.id, configId: cfg1.id },
    ]);

    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    for (const job of evalJobs()) {
      await evaluateQuestionHandler(job, { db: ctx.db, boss: recordingBoss });
    }

    const rows = await ctx.db.select().from(questionResults).where(eq(questionResults.runId, run.id));
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.status === "done")).toBe(true);

    // topK 2: the gold span sits in the top-ranked chunk, the second-ranked chunk, and neither.
    const hit = await resultFor(run.id, cfg2.id, qHit);
    expect(hit.hit).toBe(true);
    expect(hit.reciprocalRank).toBe(1);
    expect(hit.retrieved).toHaveLength(2);
    expect(hit.retrieved?.[0]).toMatchObject({ chunkId: fixtureChunks[1].id, rank: 1 });
    expect(hit.retrieved?.[0].score).toBeGreaterThan(0.99); // query is the chunk verbatim
    expect(hit.answer).toBeNull(); // retrieval-only: no answering, no judging
    expect(hit.faithfulness).toBeNull();

    const second = await resultFor(run.id, cfg2.id, qSecond);
    expect(second.hit).toBe(true);
    expect(second.reciprocalRank).toBe(0.5);
    expect(second.retrieved?.map((r) => r.chunkId))
      .toEqual([fixtureChunks[1].id, fixtureChunks[0].id]);

    const miss = await resultFor(run.id, cfg2.id, qMiss);
    expect(miss.hit).toBe(false);
    expect(miss.reciprocalRank).toBe(0);

    // topK 1 truncates the same ranking, so the rank-2 hit above becomes a miss here.
    const truncated = await resultFor(run.id, cfg1.id, qSecond);
    expect(truncated.retrieved).toHaveLength(1);
    expect(truncated.hit).toBe(false);
    expect(truncated.reciprocalRank).toBe(0);

    const [finished] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, run.id));
    expect(finished.status).toBe("done");
    expect(finished.completedJobs).toBe(finished.totalJobs);
    expect(finished.completedJobs).toBe(6);

    // The per-question query embed is metered under its own purpose, not the corpus "embed" one.
    const usage = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    expect(usage.some((u) => u.purpose === "query-embed" && u.model === "mock-embedding")).toBe(true);
  });

  it("is idempotent: re-running a delivered job neither duplicates rows nor double-counts progress", async () => {
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "idem", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const run = await makeRun("retrieval-only");
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });

    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    const jobs = evalJobs();
    for (const job of jobs) await evaluateQuestionHandler(job, { db: ctx.db, boss: recordingBoss });
    for (const job of jobs) await evaluateQuestionHandler(job, { db: ctx.db, boss: recordingBoss });

    const rows = await ctx.db.select().from(questionResults).where(eq(questionResults.runId, run.id));
    expect(rows).toHaveLength(3);
    const [after] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, run.id));
    expect(after.completedJobs).toBe(3);
    expect(after.status).toBe("done");
  });

  it("no-ops on a cancelled run", async () => {
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "cancelled-cfg", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const run = await makeRun("retrieval-only");
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });
    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    await ctx.db.update(evalRuns).set({ status: "cancelled" }).where(eq(evalRuns.id, run.id));

    for (const job of evalJobs()) await evaluateQuestionHandler(job, { db: ctx.db, boss: recordingBoss });

    const rows = await ctx.db.select().from(questionResults).where(eq(questionResults.runId, run.id));
    expect(rows).toEqual([]);
  });
});

describe("evaluateQuestionHandler (full mode)", () => {
  it("adds a grounded answer and deterministic judge scores", async () => {
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "full", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const run = await makeRun("full", { judgeModel: "mock-llm" });
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });

    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    for (const job of evalJobs()) await evaluateQuestionHandler(job, { db: ctx.db, boss: recordingBoss });

    // Every question retrieves chunk 1 first, so mockAnswer answers from it every time.
    const answered = await resultFor(run.id, cfg.id, qHit);
    expect(answered.answer).toBe(`Based on the context: ${CHUNK_TEXTS[1]}`);
    // Gold answer IS chunk 1, so the mock judge's keyword match scores it 1.
    expect(answered.correctness).toBe(1);
    expect(answered.faithfulness).toBe(1);
    expect(answered.judgeRaw).not.toBeNull();

    // Gold answer is chunk 0 (volcano), the answer is about chunk 1 -> the mock judge scores 0.
    const wrong = await resultFor(run.id, cfg.id, qSecond);
    expect(wrong.answer).toBe(`Based on the context: ${CHUNK_TEXTS[1]}`);
    expect(wrong.correctness).toBe(0);
    expect(wrong.faithfulness).toBe(0);
    // Retrieval metrics are unaffected by the judge: this is still a rank-2 hit.
    expect(wrong.reciprocalRank).toBe(0.5);

    const [finished] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, run.id));
    expect(finished.status).toBe("done");

    // Demo mode spends nothing but must still show up in the usage ledger, or an org that only ever
    // ran demo evaluations sees an empty view and cannot tell "nothing ran" from "nothing recorded".
    const usage = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    const mockAnswers = usage.filter((u) => u.purpose === "answer" && u.model === "mock-llm");
    const mockJudges = usage.filter((u) => u.purpose === "judge" && u.model === "mock-llm");
    expect(mockAnswers.length).toBeGreaterThan(0);
    expect(mockJudges.length).toBeGreaterThan(0);
    // Synthetic but real counts, at zero cost -- not a row of zeroes.
    expect(mockAnswers.every((u) => u.inputTokens > 0 && u.outputTokens > 0)).toBe(true);
    expect(mockAnswers.every((u) => u.costUsd === 0)).toBe(true);
    expect(mockJudges.every((u) => u.inputTokens > 0 && u.costUsd === 0)).toBe(true);
  });
});

describe("evaluateQuestionHandler (judged by a real model)", () => {
  // The provider seam stands in for a paid judge: these two tests are the only coverage of the
  // non-mock branch, where the reply is text that has to survive parsing. One shared queue across
  // both providers the handler constructs, so the answer call takes the first scripted reply and
  // the judge call the second.
  const scripted = (...replies: string[]): typeof makeLLM => {
    const queue = [...replies];
    return () => ({
      model: "scripted",
      async complete(): Promise<string> { return queue.shift() ?? "queue exhausted"; },
    });
  };

  async function judgedJob(name: string, llm: typeof makeLLM) {
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name, chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    // A non-mock judge with no answerModel: the run answers with its judge model too.
    const run = await makeRun("full", { judgeModel: "claude-opus-5" });
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });
    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    const job = evalJobs()[0];
    await evaluateQuestionHandler(job, { db: ctx.db, boss: recordingBoss }, makeEmbedder, llm);
    return resultFor(job.runId, job.configId, job.questionId);
  }

  it("stores the parsed scores when the judge replies with valid JSON", async () => {
    const row = await judgedJob("judge-json", scripted(
      "The chloroplast converts sunlight into glucose.",
      '{"faithfulness": 0.9, "correctness": 0.75, "reason": "close enough"}',
    ));
    expect(row.status).toBe("done");
    expect(row.answer).toBe("The chloroplast converts sunlight into glucose.");
    expect(row.faithfulness).toBe(0.9);
    expect(row.correctness).toBe(0.75);
    expect(row.judgeRaw).toEqual({ raw: '{"faithfulness": 0.9, "correctness": 0.75, "reason": "close enough"}' });
  });

  it("leaves the scores null but keeps the raw reply when the judge does not return JSON", async () => {
    const row = await judgedJob("judge-garbage", scripted("Some answer.", "not json at all"));
    // Null, never 0: an unscored answer must not be averaged in as a zero-scored one.
    expect(row.faithfulness).toBeNull();
    expect(row.correctness).toBeNull();
    expect(row.judgeRaw).toEqual({ raw: "not json at all" });
    // The retrieval half of the row is unaffected by an unparseable judge.
    expect(row.status).toBe("done");
    expect(row.hit).not.toBeNull();
  });
});

describe("evaluateQuestionHandler failure attribution", () => {
  const poisoned = (err: Error): typeof makeEmbedder => () => ({
    model: "poison", dimension: 3,
    async embed(): Promise<number[][]> { throw err; },
  });

  async function oneJob(name: string) {
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name, chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const run = await makeRun("retrieval-only");
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });
    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    return { run, job: evalJobs()[0] };
  }

  it("marks the result row failed on a non-retryable provider failure, without throwing", async () => {
    const { run, job } = await oneJob("fail-terminal");
    await expect(evaluateQuestionHandler(
      job, { db: ctx.db, boss: recordingBoss }, poisoned(new ProviderError("auth", "poison", "no credentials")),
    )).resolves.toBeUndefined();

    const row = await resultFor(job.runId, job.configId, job.questionId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("no credentials");
    expect(row.hit).toBeNull();
    // A failed question still accounts for its job, or the run would never finish.
    const [after] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, run.id));
    expect(after.completedJobs).toBe(1);
    expect(after.status).toBe("running");
  });

  it("re-evaluates a previously failed row instead of leaving the failure in place", async () => {
    const { job } = await oneJob("fail-then-recover");
    await evaluateQuestionHandler(
      job, { db: ctx.db, boss: recordingBoss }, poisoned(new ProviderError("auth", "poison", "no credentials")),
    );
    await evaluateQuestionHandler(job, { db: ctx.db, boss: recordingBoss });

    const rows = await ctx.db.select().from(questionResults).where(and(
      eq(questionResults.runId, job.runId), eq(questionResults.configId, job.configId),
    ));
    expect(rows.filter((r) => r.questionId === job.questionId)).toHaveLength(1);
    const row = await resultFor(job.runId, job.configId, job.questionId);
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
    expect(row.hit).not.toBeNull();
  });

  it("rethrows a retryable provider failure and writes no row, leaving it to pg-boss", async () => {
    const { job } = await oneJob("fail-retryable");
    await expect(evaluateQuestionHandler(
      job, { db: ctx.db, boss: recordingBoss }, poisoned(new ProviderError("rate_limit", "poison", "slow down")),
    )).rejects.toThrow("slow down");
    expect(await resultFor(job.runId, job.configId, job.questionId)).toBeUndefined();
  });

  it("keeps the retrieval result on the failed row when only the answer or judge failed", async () => {
    const poisonedLLM = (err: Error): typeof makeLLM => () => ({
      model: "poison",
      async complete(): Promise<string> { throw err; },
    });
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "llm-fail", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const run = await makeRun("full", { judgeModel: "mock-llm", answerModel: "claude-opus-5" });
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });
    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    const job = evalJobs().find((j) => j.questionId === qHit);
    if (!job) throw new Error("fan-out did not include the hit question");

    await expect(evaluateQuestionHandler(
      job, { db: ctx.db, boss: recordingBoss }, makeEmbedder,
      poisonedLLM(new ProviderError("auth", "poison", "no credentials")),
    )).resolves.toBeUndefined();

    const row = await resultFor(job.runId, job.configId, job.questionId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("no credentials");
    // Retrieval already succeeded and cost real money: throwing it away would turn a judge outage
    // into a fake retrieval miss, which is exactly the misdiagnosis this product exists to prevent.
    expect(row.hit).toBe(true);
    expect(row.reciprocalRank).toBe(1);
    expect(row.retrieved).toHaveLength(2);
    expect(row.answer).toBeNull();
    expect(row.faithfulness).toBeNull();
  });

  it("keeps the answer too when the judge is the only step that failed", async () => {
    // Answers on the first call, throws on the second: the handler builds one provider for the
    // answer and one for the judge, so this fails exactly the judge call.
    const answerThenFail = (answerText: string, err: Error): typeof makeLLM => {
      let calls = 0;
      return () => ({
        model: "half-poison",
        async complete(): Promise<string> {
          calls += 1;
          if (calls === 1) return answerText;
          throw err;
        },
      });
    };
    const [cfg] = await ctx.db.insert(ragConfigs).values({
      projectId, name: "judge-fail", chunkSetId: setId, embeddingModel: "mock-embedding", topK: 2,
    }).returning();
    const run = await makeRun("full", { judgeModel: "claude-opus-5" });
    await ctx.db.insert(evalRunConfigs).values({ runId: run.id, configId: cfg.id });
    sentJobs.length = 0;
    await startRunHandler({ runId: run.id, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    const job = evalJobs().find((j) => j.questionId === qHit);
    if (!job) throw new Error("fan-out did not include the hit question");

    await expect(evaluateQuestionHandler(
      job, { db: ctx.db, boss: recordingBoss }, makeEmbedder,
      answerThenFail("Sunlight becomes glucose.", new ProviderError("auth", "anthropic", "judge key rejected")),
    )).resolves.toBeUndefined();

    const row = await resultFor(job.runId, job.configId, job.questionId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("judge key rejected");
    // Retrieval AND the answer were paid for before the judge failed; both survive.
    expect(row.hit).toBe(true);
    expect(row.reciprocalRank).toBe(1);
    expect(row.answer).toBe("Sunlight becomes glucose.");
    // Only the judge's own output is missing.
    expect(row.judgeRaw).toBeNull();
    expect(row.faithfulness).toBeNull();
    expect(row.correctness).toBeNull();
  });

  it("propagates a failure that is not a ProviderError untouched", async () => {
    const { job } = await oneJob("fail-bug");
    const bug = new TypeError("undefined is not a function");
    await expect(evaluateQuestionHandler(
      job, { db: ctx.db, boss: recordingBoss }, poisoned(bug),
    )).rejects.toThrow(bug);
    expect(await resultFor(job.runId, job.configId, job.questionId)).toBeUndefined();
  });
});
