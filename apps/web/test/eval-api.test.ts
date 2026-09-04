import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  chunkSets, chunks, chunkEmbeddings, documents, evalRunConfigs, evalRuns, questionResults, ragConfigs,
  testQuestions, testSets,
} from "@ragbench/db";
import { createConfig, listConfigs } from "@/app/api/projects/[projectId]/configs/route";
import { createRun, listRuns } from "@/app/api/projects/[projectId]/runs/route";
import { getRun } from "@/app/api/runs/[runId]/route";
import { getResultCell } from "@/app/api/runs/[runId]/results/[configId]/[questionId]/route";
import { registerUser } from "@/lib/signup";
import { createProject } from "@/app/api/projects/route";
import { getDb } from "@/lib/db";

let orgId: string; let projectId: string;
// A session whose organizationId is not present in the organizations table at all -- the
// established pattern (see test-sets.test.ts, chunk-sets.test.ts) for probing that org-scoping
// checks compare ids rather than trusting the caller, without ever inserting rows under it.
const FOREIGN_ORG = "00000000-0000-0000-0000-000000000000";
const session = () => ({ user: { id: "u", organizationId: orgId } });
const foreignSession = () => ({ user: { id: "u", organizationId: FOREIGN_ORG } });
const sent: Array<{ queue: string; data: Record<string, unknown>; key: string }> = [];
const fakeSend = async (queue: string, data: object, key: string) => {
  sent.push({ queue, data: data as Record<string, unknown>, key });
};

function jsonReq(body: unknown) {
  return new Request("http://t/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test";
  const r = await registerUser({ email: `ev${Date.now()}@t.dev`, password: "hunter2xx", organizationName: "EV" });
  if (!r.ok) throw new Error("signup failed");
  orgId = r.organizationId;

  const pr = await createProject(jsonReq({ name: "EV proj" }) as never, session() as never);
  projectId = (await pr.json()).project.id;
});

describe("configs api", () => {
  let chunkSetId: string;

  beforeAll(async () => {
    const [set] = await getDb().insert(chunkSets).values({
      projectId, chunker: "fixed", params: { maxTokens: 50 }, paramsHash: "ph1",
    }).returning();
    chunkSetId = set.id;
  });

  it("creates a config and lists it with the chunk set's chunker/params", async () => {
    const res = await createConfig(projectId, jsonReq({ name: "Cfg A", chunkSetId, embeddingModel: "mock-embedding", topK: 5 }), session() as never);
    expect(res.status).toBe(201);
    const { config } = await res.json();
    expect(config.name).toBe("Cfg A");
    expect(config.topK).toBe(5);

    const list = await listConfigs(projectId, session() as never);
    expect(list.status).toBe(200);
    const { configs } = await list.json();
    const row = configs.find((c: { id: string }) => c.id === config.id);
    expect(row).toBeTruthy();
    expect(row.chunker).toBe("fixed");
    expect(row.chunkSetParams).toEqual({ maxTokens: 50 });
  });

  it("404s when the chunk set does not belong to the project", async () => {
    const otherRes = await createProject(jsonReq({ name: "Configs other proj" }) as never, session() as never);
    const otherProjectId = (await otherRes.json()).project.id;
    const res = await createConfig(otherProjectId, jsonReq({ name: "X", chunkSetId, embeddingModel: "mock-embedding", topK: 5 }), session() as never);
    expect(res.status).toBe(404);
  });

  it("rejects an unknown embedding model and inherited Object keys", async () => {
    expect((await createConfig(projectId, jsonReq({ name: "X", chunkSetId, embeddingModel: "nope", topK: 5 }), session() as never)).status).toBe(400);
    expect((await createConfig(projectId, jsonReq({ name: "X", chunkSetId, embeddingModel: "constructor", topK: 5 }), session() as never)).status).toBe(400);
  });

  it("rejects an empty name and out-of-range topK", async () => {
    expect((await createConfig(projectId, jsonReq({ name: "", chunkSetId, embeddingModel: "mock-embedding", topK: 5 }), session() as never)).status).toBe(400);
    expect((await createConfig(projectId, jsonReq({ name: "X", chunkSetId, embeddingModel: "mock-embedding", topK: 0 }), session() as never)).status).toBe(400);
    expect((await createConfig(projectId, jsonReq({ name: "X", chunkSetId, embeddingModel: "mock-embedding", topK: 51 }), session() as never)).status).toBe(400);
  });

  it("blocks foreign orgs and unauthenticated requests on list", async () => {
    expect((await listConfigs(projectId, foreignSession() as never)).status).toBe(404);
    expect((await listConfigs(projectId, null as never)).status).toBe(401);
  });

  it("blocks foreign orgs and unauthenticated requests on create", async () => {
    const body = { name: "X", chunkSetId, embeddingModel: "mock-embedding", topK: 5 };
    expect((await createConfig(projectId, jsonReq(body), foreignSession() as never)).status).toBe(404);
    expect((await createConfig(projectId, jsonReq(body), null as never)).status).toBe(401);
  });
});

describe("runs api", () => {
  let chunkSetId: string; let configId: string; let secondConfigId: string;
  let testSetId: string; let docId: string;

  beforeAll(async () => {
    const [doc] = await getDb().insert(documents).values({
      projectId, filename: "a.md", mime: "text/markdown", contentHash: "hA", status: "ready", text: "hello world",
    }).returning();
    docId = doc.id;

    const [set] = await getDb().insert(chunkSets).values({
      projectId, chunker: "fixed", params: { maxTokens: 50 }, paramsHash: "ph-run",
    }).returning();
    chunkSetId = set.id;

    // Build one chunk + embedding, then stamp the set's fingerprint to match -- "not stale".
    const [chunk] = await getDb().insert(chunks).values({
      chunkSetId, documentId: docId, idx: 0, text: "hello world", startOffset: 0, endOffset: 11,
    }).returning();
    await getDb().insert(chunkEmbeddings).values({
      chunkId: chunk.id, model: "mock-embedding", dimension: 3, embedding: [0.1, 0.2, 0.3],
    });
    const { computeFingerprint } = await import("@ragbench/db");
    const fingerprint = computeFingerprint("ph-run", [doc.contentHash]);
    await getDb().update(chunkSets).set({ docsFingerprint: fingerprint }).where(eq(chunkSets.id, chunkSetId));

    const cfgRes = await createConfig(projectId, jsonReq({ name: "Run Cfg A", chunkSetId, embeddingModel: "mock-embedding", topK: 3 }), session() as never);
    configId = (await cfgRes.json()).config.id;
    const cfg2Res = await createConfig(projectId, jsonReq({ name: "Run Cfg B", chunkSetId, embeddingModel: "mock-embedding", topK: 3 }), session() as never);
    secondConfigId = (await cfg2Res.json()).config.id;

    const [set2] = await getDb().insert(testSets).values({
      projectId, name: "Run TS", generatorModel: "mock-llm", questionsTarget: 5, status: "ready",
    }).returning();
    testSetId = set2.id;
    await getDb().insert(testQuestions).values({
      testSetId, documentId: docId, question: "Q1?", goldAnswer: "hello", goldStart: 0, goldEnd: 5,
    });
  });

  it("400s a test set with no active questions", async () => {
    const [emptySet] = await getDb().insert(testSets).values({
      projectId, name: "Empty TS", generatorModel: "mock-llm", questionsTarget: 5, status: "ready",
    }).returning();
    const res = await createRun(
      projectId, jsonReq({ testSetId: emptySet.id, configIds: [configId], mode: "retrieval-only" }), session() as never, fakeSend,
    );
    expect(res.status).toBe(400);
  });

  it("allows a failed test set that still has active questions", async () => {
    const [failedSet] = await getDb().insert(testSets).values({
      projectId, name: "Failed TS", generatorModel: "mock-llm", questionsTarget: 5, status: "failed", error: "boom",
    }).returning();
    await getDb().insert(testQuestions).values({
      testSetId: failedSet.id, documentId: docId, question: "Q?", goldAnswer: "hello", goldStart: 0, goldEnd: 5,
    });
    sent.length = 0;
    const res = await createRun(
      projectId, jsonReq({ testSetId: failedSet.id, configIds: [configId], mode: "retrieval-only" }), session() as never, fakeSend,
    );
    expect(res.status).toBe(201);
  });

  it("404s a test set that does not belong to the project", async () => {
    const otherRes = await createProject(jsonReq({ name: "Runs other proj A" }) as never, session() as never);
    const otherProjectId = (await otherRes.json()).project.id;
    const res = await createRun(
      otherProjectId, jsonReq({ testSetId, configIds: [configId], mode: "retrieval-only" }), session() as never, fakeSend,
    );
    expect(res.status).toBe(404);
  });

  it("404s when a config does not belong to the project", async () => {
    const otherRes = await createProject(jsonReq({ name: "Runs other proj B" }) as never, session() as never);
    const otherProjectId = (await otherRes.json()).project.id;
    const [otherTestSet] = await getDb().insert(testSets).values({
      projectId: otherProjectId, name: "Other TS", generatorModel: "mock-llm", questionsTarget: 5, status: "ready",
    }).returning();
    await getDb().insert(testQuestions).values({
      testSetId: otherTestSet.id, documentId: docId, question: "OQ?", goldAnswer: "hello", goldStart: 0, goldEnd: 5,
    });
    const res = await createRun(
      otherProjectId, jsonReq({ testSetId: otherTestSet.id, configIds: [configId], mode: "retrieval-only" }), session() as never, fakeSend,
    );
    // testSet belongs to otherProjectId, but configId belongs to projectId -- the config-ownership
    // check alone must 404 this.
    expect(res.status).toBe(404);
  });

  it("blocks foreign orgs and unauthenticated requests on create", async () => {
    expect((await createRun(projectId, jsonReq({ testSetId, configIds: [configId], mode: "retrieval-only" }), foreignSession() as never, fakeSend)).status).toBe(404);
    expect((await createRun(projectId, jsonReq({ testSetId, configIds: [configId], mode: "retrieval-only" }), null as never, fakeSend)).status).toBe(401);
  });

  it("409s with staleConfigIds when a config's chunk set is stale", async () => {
    const [staleSet] = await getDb().insert(chunkSets).values({
      projectId, chunker: "fixed", params: { maxTokens: 999 }, paramsHash: "ph-stale", docsFingerprint: "stale-value",
    }).returning();
    const staleCfgRes = await createConfig(projectId, jsonReq({ name: "Stale Cfg", chunkSetId: staleSet.id, embeddingModel: "mock-embedding", topK: 3 }), session() as never);
    const staleConfigId = (await staleCfgRes.json()).config.id;

    const res = await createRun(
      projectId, jsonReq({ testSetId, configIds: [staleConfigId], mode: "retrieval-only" }), session() as never, fakeSend,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.staleConfigIds).toEqual([staleConfigId]);
    expect(body.error).toBe(`config "Stale Cfg"'s chunk set is stale -- rebuild it before running`);
  });

  it("creates a run, defaults judgeModel to mock-llm, and enqueues start-run with the run id as key", async () => {
    sent.length = 0;
    const res = await createRun(
      projectId, jsonReq({ testSetId, configIds: [configId, secondConfigId], mode: "full" }), session() as never, fakeSend,
    );
    expect(res.status).toBe(201);
    const { run } = await res.json();
    expect(run.status).toBe("pending");
    expect(run.judgeModel).toBe("mock-llm");
    expect(sent).toEqual([{ queue: "start-run", data: { runId: run.id, organizationId: orgId }, key: run.id }]);
  });

  // The dedupe is not merely cosmetic: eval_run_configs is unique on (run_id, config_id), so a
  // duplicate id reaching the insert would abort it -- and, before the inserts were wrapped in one
  // transaction, would have left an orphaned run row with no configs behind.
  it("collapses duplicate configIds to a single eval_run_configs row", async () => {
    sent.length = 0;
    const res = await createRun(
      projectId,
      jsonReq({ testSetId, configIds: [configId, configId, secondConfigId, configId], mode: "retrieval-only" }),
      session() as never, fakeSend,
    );
    expect(res.status).toBe(201);
    const { run } = await res.json();

    const rows = await getDb().select().from(evalRunConfigs).where(eq(evalRunConfigs.runId, run.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.configId))).toEqual(new Set([configId, secondConfigId]));

    // start-run derives totalJobs from these rows, so the fan-out is 2 configs x 1 active question,
    // not the 4 the request literally listed.
    const detail = await getRun(run.id, session() as never);
    const body = await detail.json();
    expect(body.configs).toHaveLength(2);
    expect(body.configs[0].aggregates.questions).toBe(1);
  });

  it("rejects an unknown judge/answer model, a bad mode, and out-of-range configIds", async () => {
    expect((await createRun(projectId, jsonReq({ testSetId, configIds: [configId], mode: "full", judgeModel: "nope" }), session() as never, fakeSend)).status).toBe(400);
    expect((await createRun(projectId, jsonReq({ testSetId, configIds: [configId], mode: "full", answerModel: "nope" }), session() as never, fakeSend)).status).toBe(400);
    expect((await createRun(projectId, jsonReq({ testSetId, configIds: [configId], mode: "sideways" }), session() as never, fakeSend)).status).toBe(400);
    expect((await createRun(projectId, jsonReq({ testSetId, configIds: [], mode: "full" }), session() as never, fakeSend)).status).toBe(400);
    expect((await createRun(projectId, jsonReq({ testSetId, configIds: Array(7).fill(configId), mode: "full" }), session() as never, fakeSend)).status).toBe(400);
  });

  it("marks the run failed and returns 500 when scheduling fails", async () => {
    const throwingSend = async () => { throw new Error("boss down"); };
    const res = await createRun(projectId, jsonReq({ testSetId, configIds: [configId], mode: "retrieval-only" }), session() as never, throwingSend);
    expect(res.status).toBe(500);
    const body = await res.json();
    const [row] = await getDb().select().from(evalRuns).where(eq(evalRuns.id, body.runId));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("boss down");
  });

  it("lists runs with test set name, status, mode, progress, and error surfaced", async () => {
    const list = await listRuns(projectId, session() as never);
    expect(list.status).toBe(200);
    const { runs } = await list.json();
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(r).toHaveProperty("testSetName");
      expect(r).toHaveProperty("status");
      expect(r).toHaveProperty("mode");
      expect(r).toHaveProperty("totalJobs");
      expect(r).toHaveProperty("completedJobs");
      expect(r).toHaveProperty("error");
    }

    expect((await listRuns(projectId, foreignSession() as never)).status).toBe(404);
    expect((await listRuns(projectId, null as never)).status).toBe(401);
  });

  describe("run detail and cell drill-down", () => {
    let runId: string; let questionId: string;

    beforeAll(async () => {
      sent.length = 0;
      const res = await createRun(
        projectId, jsonReq({ testSetId, configIds: [configId, secondConfigId], mode: "full" }), session() as never, fakeSend,
      );
      const { run } = await res.json();
      runId = run.id;

      const [q] = await getDb().select().from(testQuestions).where(eq(testQuestions.testSetId, testSetId)).limit(1);
      questionId = q.id;

      // Seed question_results directly (worker fan-out is out of scope here): one done row with a
      // full hit + judge, and one failed row that still carries a real hit -- exercising the
      // aggregates ruling that failed rows with non-null hit still count toward hitRate/mrr.
      const [chunkRow] = await getDb().select().from(chunks).where(eq(chunks.chunkSetId, chunkSetId)).limit(1);
      await getDb().insert(questionResults).values([
        {
          runId, configId, questionId,
          retrieved: [{ chunkId: chunkRow.id, rank: 1, score: 0.9 }],
          hit: true, reciprocalRank: 1, answer: "hello", faithfulness: 0.8, correctness: 0.9,
          judgeRaw: { raw: '{"faithfulness":0.8,"correctness":0.9}' }, status: "done",
        },
        {
          runId, configId: secondConfigId, questionId,
          retrieved: [{ chunkId: chunkRow.id, rank: 1, score: 0.5 }],
          hit: true, reciprocalRank: 0.5, answer: "partial", faithfulness: null, correctness: null,
          judgeRaw: null, status: "failed", error: "judge outage",
        },
      ]);
    });

    it("computes on-read aggregates honoring the failed-row-with-hit ruling", async () => {
      const res = await getRun(runId, session() as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.run.id).toBe(runId);
      expect(body.run.error).toBeNull();

      const cfgA = body.configs.find((c: { config: { id: string } }) => c.config.id === configId);
      expect(cfgA.aggregates.questions).toBe(1);
      expect(cfgA.aggregates.evaluated).toBe(1);
      expect(cfgA.aggregates.failed).toBe(0);
      expect(cfgA.aggregates.hitRate).toBe(1);
      expect(cfgA.aggregates.mrr).toBe(1);
      expect(cfgA.aggregates.avgFaithfulness).toBeCloseTo(0.8);
      expect(cfgA.aggregates.avgCorrectness).toBeCloseTo(0.9);

      const cfgB = body.configs.find((c: { config: { id: string } }) => c.config.id === secondConfigId);
      expect(cfgB.aggregates.evaluated).toBe(0);
      expect(cfgB.aggregates.failed).toBe(1);
      // Failed row still carries a real hit/rr -- must count toward hitRate/mrr per the ruling.
      expect(cfgB.aggregates.hitRate).toBe(1);
      expect(cfgB.aggregates.mrr).toBe(0.5);
      expect(cfgB.aggregates.avgFaithfulness).toBeNull();
      expect(cfgB.aggregates.avgCorrectness).toBeNull();

      expect(body.grid).toHaveLength(1);
      const row = body.grid[0];
      expect(row.questionId).toBe(questionId);
      expect(row.perConfig[configId]).toEqual({ hit: true, reciprocalRank: 1, status: "done" });
      expect(row.perConfig[secondConfigId]).toEqual({ hit: true, reciprocalRank: 0.5, status: "failed" });
    });

    it("blocks foreign orgs and unauthenticated requests on run detail", async () => {
      expect((await getRun(runId, foreignSession() as never)).status).toBe(404);
      expect((await getRun(runId, null as never)).status).toBe(401);
      expect((await getRun("00000000-0000-0000-0000-000000000000", session() as never)).status).toBe(404);
    });

    it("hydrates a cell's retrieved chunks with text and filename", async () => {
      const res = await getResultCell(runId, configId, questionId, session() as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.answer).toBe("hello");
      expect(body.result.status).toBe("done");
      expect(body.result.retrieved).toHaveLength(1);
      expect(body.result.retrieved[0].text).toBe("hello world");
      expect(body.result.retrieved[0].filename).toBe("a.md");
      expect(body.question.question).toBe("Q1?");
    });

    it("blocks foreign orgs, unauthenticated requests, and unknown cells on the drill-down", async () => {
      expect((await getResultCell(runId, configId, questionId, foreignSession() as never)).status).toBe(404);
      expect((await getResultCell(runId, configId, questionId, null as never)).status).toBe(401);
      expect((await getResultCell(runId, "00000000-0000-0000-0000-000000000000", questionId, session() as never)).status).toBe(404);
    });
  });

  describe("frozen question denominator", () => {
    it("keeps `questions` at the fan-out count after a mid-run question soft-delete", async () => {
      const [freezeSet] = await getDb().insert(testSets).values({
        projectId, name: "Freeze TS", generatorModel: "mock-llm", questionsTarget: 5, status: "ready",
      }).returning();
      const [q1] = await getDb().insert(testQuestions).values([
        { testSetId: freezeSet.id, documentId: docId, question: "F1?", goldAnswer: "hello", goldStart: 0, goldEnd: 5 },
        { testSetId: freezeSet.id, documentId: docId, question: "F2?", goldAnswer: "hello", goldStart: 0, goldEnd: 5 },
      ]).returning();

      const res = await createRun(
        projectId, jsonReq({ testSetId: freezeSet.id, configIds: [configId], mode: "retrieval-only" }), session() as never, fakeSend,
      );
      const { run } = await res.json();

      // Simulate start-run's fan-out having happened (1 config x 2 questions = 2 total jobs)
      // without actually running the worker.
      await getDb().update(evalRuns).set({ status: "running", totalJobs: 2 }).where(eq(evalRuns.id, run.id));

      // A question soft-deleted mid-run must not shrink the denominator: evaluated/failed are
      // counted against the frozen fan-out (totalJobs), not against whatever is still active now.
      await getDb().update(testQuestions).set({ status: "deleted" }).where(eq(testQuestions.id, q1.id));

      const detail = await getRun(run.id, session() as never);
      const body = await detail.json();
      expect(body.configs[0].aggregates.questions).toBe(2);
    });

    it("uses the live active-question count while the run is still pending", async () => {
      const [pendingSet] = await getDb().insert(testSets).values({
        projectId, name: "Pending TS", generatorModel: "mock-llm", questionsTarget: 5, status: "ready",
      }).returning();
      await getDb().insert(testQuestions).values([
        { testSetId: pendingSet.id, documentId: docId, question: "P1?", goldAnswer: "hello", goldStart: 0, goldEnd: 5 },
        { testSetId: pendingSet.id, documentId: docId, question: "P2?", goldAnswer: "hello", goldStart: 0, goldEnd: 5 },
        { testSetId: pendingSet.id, documentId: docId, question: "P3?", goldAnswer: "hello", goldStart: 0, goldEnd: 5 },
      ]);

      const res = await createRun(
        projectId, jsonReq({ testSetId: pendingSet.id, configIds: [configId], mode: "retrieval-only" }), session() as never, fakeSend,
      );
      const { run } = await res.json();
      expect(run.totalJobs).toBe(0); // still pending -- start-run (task 3) hasn't fanned out

      const detail = await getRun(run.id, session() as never);
      const body = await detail.json();
      expect(body.configs[0].aggregates.questions).toBe(3);
    });
  });
});
