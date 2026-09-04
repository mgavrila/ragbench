import { describe, it, expect, beforeAll } from "vitest";
import { chunkEmbeddings, chunks, documents } from "@ragbench/db";
import { createChunkSet, listChunkSets } from "@/app/api/projects/[projectId]/chunk-sets/route";
import { registerUser } from "@/lib/signup";
import { createProject } from "@/app/api/projects/route";
import { getDb } from "@/lib/db";

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

  it("creates a set, records the embed model on the row, and enqueues only the chunk job", async () => {
    const res = await createChunkSet(projectId, req({ chunker: "fixed", params: { maxTokens: 50 }, embedModel: "mock-embedding" }), session() as never, fakeSend);
    expect(res.status).toBe(201);
    const { chunkSet } = await res.json();
    setId = chunkSet.id;
    expect(chunkSet.embedModels).toEqual(["mock-embedding"]);
    // embed is chained by chunkHandler (reading embedModels off the row post-commit), never
    // dispatched from here, and the payload no longer carries embedModel at all.
    expect(sent.map((s) => s.queue)).toEqual(["chunk"]);
    expect(sent[0].key).toBe(chunkSet.id);
    expect(sent[0].data).toEqual({ chunkSetId: chunkSet.id, organizationId: orgId });
  });

  it("returns the existing set on re-POST and re-enqueues the rebuild", async () => {
    sent.length = 0;
    const again = await createChunkSet(projectId, req({ chunker: "fixed", params: { maxTokens: 50 }, embedModel: "mock-embedding" }), session() as never, fakeSend);
    expect(again.status).toBe(200); // existing set returned, no duplicate row
    const { chunkSet } = await again.json();
    expect(chunkSet.id).toBe(setId);
    // Already-recorded model is not duplicated.
    expect(chunkSet.embedModels).toEqual(["mock-embedding"]);
    // Re-chunking is the point: documents uploaded since the set was created belong in it too.
    expect(sent.map((s) => s.queue)).toEqual(["chunk"]);
    expect(sent[0].key).toBe(setId);
  });

  it("appends a second embed model to an existing set instead of dropping it", async () => {
    sent.length = 0;
    const res = await createChunkSet(
      projectId, req({ chunker: "fixed", params: { maxTokens: 50 }, embedModel: "text-embedding-3-small" }),
      session() as never, fakeSend,
    );
    expect(res.status).toBe(200);
    const { chunkSet } = await res.json();
    expect(chunkSet.id).toBe(setId);
    expect(chunkSet.embedModels).toEqual(["mock-embedding", "text-embedding-3-small"]);
    expect(sent[0].data).toEqual({ chunkSetId: setId, organizationId: orgId });
  });

  // The append is a single `embed_models || '["m"]'::jsonb` statement guarded by `NOT (... @> ...)`,
  // so that two concurrent POSTs for different models cannot lose each other's write. The guard is
  // what keeps that statement idempotent -- without it, re-requesting a model the set already has
  // would concatenate a second copy and chunkHandler would chain a duplicate embed job per rebuild.
  it("appends the same model only once no matter how often it is requested", async () => {
    const body = { chunker: "fixed", params: { maxTokens: 123 }, embedModel: "mock-embedding" };
    const first = await createChunkSet(projectId, req(body), session() as never, fakeSend);
    expect(first.status).toBe(201);
    const created = (await first.json()).chunkSet;

    for (let i = 0; i < 3; i++) {
      const again = await createChunkSet(projectId, req(body), session() as never, fakeSend);
      expect(again.status).toBe(200);
      const { chunkSet } = await again.json();
      expect(chunkSet.id).toBe(created.id);
      expect(chunkSet.embedModels).toEqual(["mock-embedding"]);
    }
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

  // `setId` has had two models requested (mock-embedding, text-embedding-3-small) but nothing has
  // run the embed handler in this suite, so only the vectors seeded here exist. The two lists must
  // come back different: the picker greys out a requested model until it can actually retrieve.
  it("reports embedded models separately from merely-requested ones", async () => {
    const [doc] = await getDb().insert(documents).values({
      projectId, filename: "e.md", mime: "text/markdown", contentHash: `he${Date.now()}`,
      status: "ready", text: "hello world",
    }).returning();
    const [chunk] = await getDb().insert(chunks).values({
      chunkSetId: setId, documentId: doc.id, idx: 0, text: "hello world", startOffset: 0, endOffset: 11,
    }).returning();
    await getDb().insert(chunkEmbeddings).values({
      chunkId: chunk.id, model: "mock-embedding", dimension: 3, embedding: [0.1, 0.2, 0.3],
    });

    const list = await listChunkSets(projectId, session() as never);
    const { chunkSets } = await list.json();
    const row = chunkSets.find((s: { id: string }) => s.id === setId);
    expect(row.embedModels).toEqual(["mock-embedding", "text-embedding-3-small"]);
    expect(row.embeddedModels).toEqual(["mock-embedding"]);
    // The join must not inflate the aggregate: one chunk, one embedding, still one chunk.
    expect(row.chunkCount).toBe(1);

    // A set with no embeddings at all reports an empty list rather than being omitted.
    const bare = chunkSets.find((s: { id: string; chunker: string }) => s.chunker === "heading");
    expect(bare.embeddedModels).toEqual([]);
  });
});
