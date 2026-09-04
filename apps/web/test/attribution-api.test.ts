import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  attributions, chunkEmbeddings, chunkSets, chunks, documents, evalRunConfigs, evalRuns, questionResults,
  ragConfigs, testQuestions, testSets,
} from "@ragbench/db";
import { diagnoseResult } from "@/app/api/results/[resultId]/diagnose/route";
import { getAttribution } from "@/app/api/results/[resultId]/attribution/route";
import { registerUser } from "@/lib/signup";
import { createProject } from "@/app/api/projects/route";
import { getDb } from "@/lib/db";

// Same pattern as eval-api.test.ts: a session whose organizationId is absent from `organizations`
// entirely, to probe that org-scoping compares ids rather than trusting the caller.
const FOREIGN_ORG = "00000000-0000-0000-0000-000000000000";
const NON_UUID = "not-a-real-id";

let orgId: string; let projectId: string; let resultId: string;
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
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
  const r = await registerUser({ email: `attr${Date.now()}@t.dev`, password: "hunter2xx", organizationName: "ATTR" });
  if (!r.ok) throw new Error("signup failed");
  orgId = r.organizationId;

  const pr = await createProject(jsonReq({ name: "Attr proj" }) as never, session() as never);
  projectId = (await pr.json()).project.id;

  const db = getDb();
  const [doc] = await db.insert(documents).values({
    projectId, filename: "a.md", mime: "text/markdown", contentHash: "hA", status: "ready", text: "the quick brown fox jumps over the lazy dog",
  }).returning();

  const [set] = await db.insert(chunkSets).values({
    projectId, chunker: "fixed", params: { maxTokens: 50 }, paramsHash: "ph-attr",
  }).returning();

  const [chunk] = await db.insert(chunks).values({
    chunkSetId: set.id, documentId: doc.id, idx: 0, text: "the quick brown fox", startOffset: 0, endOffset: 19,
  }).returning();
  await db.insert(chunkEmbeddings).values({
    chunkId: chunk.id, model: "mock-embedding", dimension: 3, embedding: [0.1, 0.2, 0.3],
  });

  const [config] = await db.insert(ragConfigs).values({
    projectId, name: "Cfg", chunkSetId: set.id, embeddingModel: "mock-embedding", topK: 1,
  }).returning();

  const [testSet] = await db.insert(testSets).values({
    projectId, name: "TS", generatorModel: "mock-llm", status: "ready",
  }).returning();
  const [question] = await db.insert(testQuestions).values({
    testSetId: testSet.id, documentId: doc.id, question: "Q?", goldAnswer: "fox", goldStart: 10, goldEnd: 19,
  }).returning();

  const [run] = await db.insert(evalRuns).values({
    projectId, testSetId: testSet.id, mode: "retrieval-only", status: "done",
  }).returning();
  await db.insert(evalRunConfigs).values({ runId: run.id, configId: config.id });

  const [result] = await db.insert(questionResults).values({
    runId: run.id, configId: config.id, questionId: question.id,
    retrieved: [{ chunkId: chunk.id, rank: 1, score: 0.5 }], hit: false, reciprocalRank: 0, status: "done",
  }).returning();
  resultId = result.id;
});

describe("diagnose api", () => {
  it("enqueues the attribute job with the exact queue, singletonKey, and payload", async () => {
    sent.length = 0;
    const res = await diagnoseResult(resultId, session() as never, fakeSend);
    expect(res.status).toBe(202);

    expect(sent).toHaveLength(1);
    expect(sent[0].queue).toBe("attribute");
    expect(sent[0].key).toBe(resultId);
    expect(sent[0].data).toEqual({ resultId, organizationId: orgId });
  });

  it("blocks foreign orgs and unauthenticated requests", async () => {
    expect((await diagnoseResult(resultId, foreignSession() as never, fakeSend)).status).toBe(404);
    expect((await diagnoseResult(resultId, null as never, fakeSend)).status).toBe(401);
  });

  it("404s a non-UUID resultId instead of 500ing on an invalid uuid query", async () => {
    const res = await diagnoseResult(NON_UUID, session() as never, fakeSend);
    expect(res.status).toBe(404);
  });

  it("404s an unknown (but well-formed) resultId", async () => {
    const res = await diagnoseResult("00000000-0000-0000-0000-000000000000", session() as never, fakeSend);
    expect(res.status).toBe(404);
  });

  it("500s and reports the error when the send fails", async () => {
    const failingSend = async () => { throw new Error("queue down"); };
    const res = await diagnoseResult(resultId, session() as never, failingSend);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("queue down");
  });
});

describe("attribution api", () => {
  it("returns { attribution: null } with the result status before any diagnosis has run", async () => {
    const res = await getAttribution(resultId, session() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attribution).toBeNull();
    expect(body.resultStatus).toBe("done");
  });

  it("returns the stored attribution once the worker has written one", async () => {
    const counterfactuals = {
      matrix: [{ kind: "topk", label: "k=2", hit: true, rank: 2 }],
      skipped: ["embedder \"openai-text\": no credentials for openai"],
      rule: "topk-recovers",
      signals: { goldInSingleChunk: true, bestGoldRank: 2, k: 1 },
    };
    await getDb().insert(attributions).values({
      resultId, verdict: "retrieval", counterfactuals, explanation: "raised k recovers it",
      evidenceChunkIds: ["c1"],
    });

    const res = await getAttribution(resultId, session() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resultStatus).toBe("done");
    expect(body.attribution.resultId).toBe(resultId);
    expect(body.attribution.verdict).toBe("retrieval");
    expect(body.attribution.explanation).toBe("raised k recovers it");
    expect(body.attribution.evidenceChunkIds).toEqual(["c1"]);
    expect(body.attribution.counterfactuals).toEqual(counterfactuals);
  });

  it("blocks foreign orgs and unauthenticated requests", async () => {
    expect((await getAttribution(resultId, foreignSession() as never)).status).toBe(404);
    expect((await getAttribution(resultId, null as never)).status).toBe(401);
  });

  it("404s a non-UUID resultId instead of 500ing on an invalid uuid query", async () => {
    const res = await getAttribution(NON_UUID, session() as never);
    expect(res.status).toBe(404);
  });
});
