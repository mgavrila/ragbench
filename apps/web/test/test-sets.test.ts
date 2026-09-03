import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { documents, testQuestions, testSets } from "@ragbench/db";
import { createTestSet, listTestSets } from "@/app/api/projects/[projectId]/test-sets/route";
import { estimateTestSet } from "@/app/api/projects/[projectId]/test-sets/estimate/route";
import { listQuestions } from "@/app/api/test-sets/[testSetId]/questions/route";
import { deleteQuestion } from "@/app/api/questions/[questionId]/route";
import { registerUser } from "@/lib/signup";
import { createProject } from "@/app/api/projects/route";
import { getDb } from "@/lib/db";

let orgId: string; let projectId: string; let emptyProjectId: string;
const FOREIGN_ORG = "00000000-0000-0000-0000-000000000000";
const session = () => ({ user: { id: "u", organizationId: orgId } });
const foreignSession = () => ({ user: { id: "u", organizationId: FOREIGN_ORG } });
const sent: Array<{ queue: string; data: Record<string, unknown>; key: string }> = [];
const fakeSend = async (queue: string, data: object, key: string) => {
  sent.push({ queue, data: data as Record<string, unknown>, key });
};

function jsonReq(body: unknown) {
  return new Request("http://t/ts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function estimateReq(qs: string) {
  return new Request(`http://t/ts/estimate?${qs}`);
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
  const r = await registerUser({ email: `ts${Date.now()}@t.dev`, password: "hunter2xx", organizationName: "TS" });
  if (!r.ok) throw new Error("signup failed");
  orgId = r.organizationId;

  const pr = await createProject(jsonReq({ name: "TS proj" }) as never, session() as never);
  projectId = (await pr.json()).project.id;
  const epr = await createProject(jsonReq({ name: "TS empty proj" }) as never, session() as never);
  emptyProjectId = (await epr.json()).project.id;

  // Two ready documents, seeded directly (parse pipeline is out of scope here).
  await getDb().insert(documents).values([
    { projectId, filename: "a.md", mime: "text/markdown", contentHash: "h1", status: "ready", text: "hello world" },
    { projectId, filename: "b.md", mime: "text/markdown", contentHash: "h2", status: "ready", text: "another doc" },
  ]);
});

describe("test-sets estimate", () => {
  it("estimates zero cost for the mock model", async () => {
    const res = await estimateTestSet(projectId, estimateReq("model=mock-llm&count=10"), session() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.estimatedUsd).toBe(0);
    expect(body.documents).toBe(2);
    expect(body.inputTokens).toBeGreaterThan(0);
    expect(body.outputTokens).toBeGreaterThan(0);
  });

  it("estimates a plausible positive cost for a real model, including the triviality gate", async () => {
    const mockRes = await estimateTestSet(projectId, estimateReq("model=mock-llm&count=10"), session() as never);
    const mockBody = await mockRes.json();

    const res = await estimateTestSet(projectId, estimateReq("model=claude-haiku-4-5&count=10"), session() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.estimatedUsd).toBeGreaterThan(0);
    // A real generator's estimate must be a small, plausible dollar amount, not a units mistake.
    expect(body.estimatedUsd).toBeLessThan(1);
    // The gate's tokens are on top of the mock model's generator-only baseline.
    expect(body.inputTokens).toBeGreaterThan(mockBody.inputTokens);
    expect(body.outputTokens).toBeGreaterThan(mockBody.outputTokens);
  });

  it("rejects an unknown model, including inherited Object keys", async () => {
    expect((await estimateTestSet(projectId, estimateReq("model=nope&count=10"), session() as never)).status).toBe(400);
    expect((await estimateTestSet(projectId, estimateReq("model=constructor&count=10"), session() as never)).status).toBe(400);
  });

  it("rejects a missing or out-of-range count", async () => {
    expect((await estimateTestSet(projectId, estimateReq("model=mock-llm"), session() as never)).status).toBe(400);
    expect((await estimateTestSet(projectId, estimateReq("model=mock-llm&count=0"), session() as never)).status).toBe(400);
    expect((await estimateTestSet(projectId, estimateReq("model=mock-llm&count=201"), session() as never)).status).toBe(400);
  });

  it("still returns 200 with a warning when the project has no ready documents", async () => {
    const res = await estimateTestSet(emptyProjectId, estimateReq("model=mock-llm&count=10"), session() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toBe(0);
    expect(body.warning).toBeTruthy();
  });

  it("blocks foreign orgs and unauthenticated requests", async () => {
    expect((await estimateTestSet(projectId, estimateReq("model=mock-llm&count=10"), foreignSession() as never)).status).toBe(404);
    expect((await estimateTestSet(projectId, estimateReq("model=mock-llm&count=10"), null as never)).status).toBe(401);
  });
});

describe("test-sets create/list", () => {
  let setId: string;

  it("creates a set, enqueues generate-testset with the set id as key, and starts generating", async () => {
    sent.length = 0;
    const res = await createTestSet(projectId, jsonReq({ name: "Set A", generatorModel: "mock-llm", questionsTarget: 5 }), session() as never, fakeSend);
    expect(res.status).toBe(201);
    const { testSet } = await res.json();
    setId = testSet.id;
    expect(testSet.status).toBe("generating");
    expect(sent).toEqual([{ queue: "generate-testset", data: { testSetId: setId, organizationId: orgId }, key: setId }]);
  });

  it("re-POSTing creates a brand new set rather than upserting", async () => {
    sent.length = 0;
    const res = await createTestSet(projectId, jsonReq({ name: "Set A", generatorModel: "mock-llm", questionsTarget: 5 }), session() as never, fakeSend);
    expect(res.status).toBe(201);
    const { testSet } = await res.json();
    expect(testSet.id).not.toBe(setId);
    expect(sent[0].key).toBe(testSet.id);
  });

  it("defaults questionsTarget to 30 and rejects an unknown generator model", async () => {
    const res = await createTestSet(projectId, jsonReq({ name: "Set B", generatorModel: "mock-llm" }), session() as never, fakeSend);
    expect(res.status).toBe(201);
    expect((await res.json()).testSet.questionsTarget).toBe(30);

    const bad = await createTestSet(projectId, jsonReq({ name: "Set C", generatorModel: "nope" }), session() as never, fakeSend);
    expect(bad.status).toBe(400);
    const badInherited = await createTestSet(projectId, jsonReq({ name: "Set C", generatorModel: "constructor" }), session() as never, fakeSend);
    expect(badInherited.status).toBe(400);
  });

  it("rejects an empty name and out-of-range questionsTarget", async () => {
    expect((await createTestSet(projectId, jsonReq({ name: "", generatorModel: "mock-llm" }), session() as never, fakeSend)).status).toBe(400);
    expect((await createTestSet(projectId, jsonReq({ name: "x", generatorModel: "mock-llm", questionsTarget: 0 }), session() as never, fakeSend)).status).toBe(400);
    expect((await createTestSet(projectId, jsonReq({ name: "x", generatorModel: "mock-llm", questionsTarget: 201 }), session() as never, fakeSend)).status).toBe(400);
  });

  it("marks the set failed and returns 500 when scheduling fails, without blocking a fresh retry", async () => {
    const throwingSend = async () => { throw new Error("boss down"); };
    const res = await createTestSet(projectId, jsonReq({ name: "Set D", generatorModel: "mock-llm" }), session() as never, throwingSend);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.testSetId).toBeTruthy();
    const [row] = await getDb().select().from(testSets).where(eq(testSets.id, body.testSetId));
    expect(row.status).toBe("failed");
    // The scheduler's own message is what says WHY nothing was queued, so it is kept on the row
    // (the response body stays generic -- the caller cannot act on the difference).
    expect(row.error).toContain("boss down");

    sent.length = 0;
    const retry = await createTestSet(projectId, jsonReq({ name: "Set D retry", generatorModel: "mock-llm" }), session() as never, fakeSend);
    expect(retry.status).toBe(201);
  });

  it("lists sets with active-question counts and blocks foreign orgs", async () => {
    const list = await listTestSets(projectId, session() as never);
    expect(list.status).toBe(200);
    const { testSets: rows } = await list.json();
    const row = rows.find((s: { id: string }) => s.id === setId);
    expect(row).toBeTruthy();
    expect(row.questionCount).toBe(0);
    for (const s of rows) expect(s).toHaveProperty("questionCount");

    expect((await listTestSets(projectId, foreignSession() as never)).status).toBe(404);
    expect((await listTestSets(projectId, null as never)).status).toBe(401);
  });
});

describe("questions review", () => {
  let setId: string; let docId: string; let activeQId: string; let deletedQId: string;

  beforeAll(async () => {
    const [doc] = await getDb().select().from(documents).where(eq(documents.projectId, projectId)).limit(1);
    docId = doc.id;
    const [set] = await getDb().insert(testSets).values({
      projectId, name: "QSet", generatorModel: "mock-llm", questionsTarget: 5, status: "failed", error: "boom",
    }).returning();
    setId = set.id;
    const [active] = await getDb().insert(testQuestions).values({
      testSetId: setId, documentId: docId, question: "Q1?", goldAnswer: "A1", goldStart: 0, goldEnd: 2,
    }).returning();
    activeQId = active.id;
    const [deleted] = await getDb().insert(testQuestions).values({
      testSetId: setId, documentId: docId, question: "Q2?", goldAnswer: "A2", goldStart: 0, goldEnd: 2, status: "deleted",
    }).returning();
    deletedQId = deleted.id;
  });

  it("lists active questions (even for a failed set) joined with the document filename", async () => {
    const res = await listQuestions(setId, session() as never);
    expect(res.status).toBe(200);
    const { questions } = await res.json();
    const ids = questions.map((q: { id: string }) => q.id);
    expect(ids).toContain(activeQId);
    expect(ids).not.toContain(deletedQId);
    const row = questions.find((q: { id: string }) => q.id === activeQId);
    expect(row.filename).toBe("a.md");
  });

  it("blocks foreign orgs and unauthenticated requests on questions listing", async () => {
    expect((await listQuestions(setId, foreignSession() as never)).status).toBe(404);
    expect((await listQuestions(setId, null as never)).status).toBe(401);
    expect((await listQuestions("00000000-0000-0000-0000-000000000000", session() as never)).status).toBe(404);
  });

  it("deletes a question (flips status) and excludes it from a subsequent list", async () => {
    const res = await deleteQuestion(activeQId, session() as never);
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(testQuestions).where(eq(testQuestions.id, activeQId));
    expect(row.status).toBe("deleted");

    const list = await listQuestions(setId, session() as never);
    const { questions } = await list.json();
    expect(questions.map((q: { id: string }) => q.id)).not.toContain(activeQId);
  });

  it("blocks foreign orgs and unauthenticated requests on delete", async () => {
    expect((await deleteQuestion(deletedQId, foreignSession() as never)).status).toBe(404);
    expect((await deleteQuestion(deletedQId, null as never)).status).toBe(401);
    expect((await deleteQuestion("00000000-0000-0000-0000-000000000000", session() as never)).status).toBe(404);
  });
});
