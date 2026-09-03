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
  if (!r.ok) throw new Error("signup failed");
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
