import { describe, it, expect, beforeAll } from "vitest";
import { createChunkSet, listChunkSets } from "@/app/api/projects/[projectId]/chunk-sets/route";
import { registerUser } from "@/lib/signup";
import { createProject } from "@/app/api/projects/route";

let orgId: string; let projectId: string;
const session = () => ({ user: { id: "u", organizationId: orgId } });
const sent: Array<{ queue: string; data: Record<string, unknown>; key: string }> = [];
const fakeSend = async (queue: string, data: object, key: string) => {
  sent.push({ queue, data: data as Record<string, unknown>, key });
};

function req(body: unknown) {
  return new Request("http://t/cs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
  const r = await registerUser({ email: `cs${Date.now()}@t.dev`, password: "hunter2xx", organizationName: "CS" });
  if (!r.ok) throw new Error("signup failed");
  orgId = r.organizationId;
  const pr = await createProject(req({ name: "CS proj" }) as never, session() as never);
  projectId = (await pr.json()).project.id;
});

describe("chunk-sets api", () => {
  let setId: string;

  it("creates a set and enqueues only the chunk job, carrying the embed model", async () => {
    const res = await createChunkSet(projectId, req({ chunker: "fixed", params: { maxTokens: 50 }, embedModel: "mock-embedding" }), session() as never, fakeSend);
    expect(res.status).toBe(201);
    const { chunkSet } = await res.json();
    setId = chunkSet.id;
    // embed is chained by chunkHandler after its rebuild commits, never dispatched from here.
    expect(sent.map((s) => s.queue)).toEqual(["chunk"]);
    expect(sent[0].key).toBe(chunkSet.id);
    expect(sent[0].data).toEqual({ chunkSetId: chunkSet.id, embedModel: "mock-embedding", organizationId: orgId });
  });

  it("returns the existing set on re-POST and re-enqueues the rebuild", async () => {
    sent.length = 0;
    const again = await createChunkSet(projectId, req({ chunker: "fixed", params: { maxTokens: 50 }, embedModel: "mock-embedding" }), session() as never, fakeSend);
    expect(again.status).toBe(200); // existing set returned, no duplicate row
    expect((await again.json()).chunkSet.id).toBe(setId);
    // Re-chunking is the point: documents uploaded since the set was created belong in it too.
    expect(sent.map((s) => s.queue)).toEqual(["chunk"]);
    expect(sent[0].key).toBe(setId);
  });

  it("rejects unknown chunkers and embedding models, including inherited Object keys", async () => {
    expect((await createChunkSet(projectId, req({ chunker: "nope" }), session() as never, fakeSend)).status).toBe(400);
    expect((await createChunkSet(projectId, req({ chunker: "fixed", embedModel: "nope" }), session() as never, fakeSend)).status).toBe(400);
    expect((await createChunkSet(projectId, req({ chunker: "fixed", embedModel: "constructor" }), session() as never, fakeSend)).status).toBe(400);
  });

  it("rejects out-of-range, wrong-shape and unknown chunker params", async () => {
    const bad = [
      { chunker: "fixed", params: { maxTokens: 0 } },
      { chunker: "fixed", params: { maxTokens: 5_000_000 } },
      { chunker: "fixed", params: { maxTokens: 2.5 } },
      { chunker: "fixed", params: { maxTokens: "abc" } },
      { chunker: "fixed", params: { overlapTokens: -1 } },
      { chunker: "fixed", params: { maxChars: 500 } }, // belongs to heading
      { chunker: "heading", params: { maxChars: 1 } },
      { chunker: "heading", params: { maxChars: 999_999 } },
      { chunker: "sentence-window", params: { windowSentences: 0 } },
      { chunker: "sentence-window", params: { overlapSentences: 99 } },
    ];
    for (const body of bad) {
      const res = await createChunkSet(projectId, req(body), session() as never, fakeSend);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("accepts in-range params for every chunker", async () => {
    const good = [
      { chunker: "heading", params: { maxChars: 2000 } },
      { chunker: "sentence-window", params: { windowSentences: 4, overlapSentences: 1 } },
    ];
    for (const body of good) {
      const res = await createChunkSet(projectId, req(body), session() as never, fakeSend);
      expect(res.status, JSON.stringify(body)).toBe(201);
    }
  });

  it("reports a scheduling failure without leaving the set silently unscheduled", async () => {
    const throwingSend = async () => { throw new Error("boss down"); };
    const res = await createChunkSet(projectId, req({ chunker: "fixed", params: { maxTokens: 77 } }), session() as never, throwingSend);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("failed to schedule chunking");
    expect(body.chunkSetId).toBeTruthy();
    // Recoverable: the same request now finds the existing set and enqueues again.
    sent.length = 0;
    const retry = await createChunkSet(projectId, req({ chunker: "fixed", params: { maxTokens: 77 } }), session() as never, fakeSend);
    expect(retry.status).toBe(200);
    expect(sent.map((s) => s.queue)).toEqual(["chunk"]);
  });

  it("lists sets with chunk counts and blocks foreign orgs", async () => {
    const list = await listChunkSets(projectId, session() as never);
    const { chunkSets } = await list.json();
    expect(chunkSets.map((s: { id: string }) => s.id)).toContain(setId);
    for (const s of chunkSets) expect(s).toHaveProperty("chunkCount");
    expect((await listChunkSets(projectId, { user: { id: "u", organizationId: "00000000-0000-0000-0000-000000000000" } } as never)).status).toBe(404);
  });
});
