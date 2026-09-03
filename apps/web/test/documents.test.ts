import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { documentPath, documents } from "@ragbench/db";
import { listDocuments, uploadDocument } from "@/app/api/projects/[projectId]/documents/route";
import { registerUser } from "@/lib/signup";
import { createProject } from "@/app/api/projects/route";
import { getDb } from "@/lib/db";

let orgId: string; let projectId: string;
const session = () => ({ user: { id: "u", organizationId: orgId } });
const sent: Array<{ queue: string; data: unknown; key: string }> = [];
const fakeSend = async (queue: string, data: object, key: string) => { sent.push({ queue, data, key }); };

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
  const res = await registerUser({ email: `d${Date.now()}@t.dev`, password: "hunter2xx", organizationName: "D" });
  if (!res.ok) throw new Error("signup failed");
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

  it("rejects files over the 20MB limit", async () => {
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.md", { type: "text/markdown" });
    const req = new Request("http://t/upload", { method: "POST", body: (() => {
      const fd = new FormData();
      fd.set("file", big);
      return fd;
    })() });
    const res = await uploadDocument(projectId, req, session() as never, fakeSend);
    expect(res.status).toBe(413);
  });

  it("marks the document failed and returns 500 when post-write processing throws", async () => {
    const failingSend = async () => { throw new Error("boom"); };
    const res = await uploadDocument(projectId, uploadReq("crash.md", "text/markdown", "x"), session() as never, failingSend);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("upload failed");
    expect(body.documentId).toBeTruthy();

    const [row] = await getDb().select().from(documents).where(eq(documents.id, body.documentId));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("boom");
  });
});
