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

// Recording stand-in for pg-boss: enqueue() only needs send(), and every job the handlers dispatch
// lands here instead of a real queue. `chunksVisible` is captured at send time so a test can prove
// the enqueue happened after the rebuild transaction committed, not inside it.
const sentJobs: Array<{ name: string; data: unknown; opts: unknown; chunksVisible: number }> = [];
const recordingBoss = {
  async send(name: string, data: unknown, opts: unknown) {
    const rows = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId));
    sentJobs.push({ name, data, opts, chunksVisible: rows.length });
    return "job-1";
  },
} as never;

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
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: recordingBoss });
    const rows = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId));
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r.documentId)).size).toBe(1); // only the ready doc
  });

  it("is idempotent (re-run replaces, not duplicates)", async () => {
    const before = (await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId))).length;
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: recordingBoss });
    const after = (await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId))).length;
    expect(after).toBe(before);
  });

  it("enqueues nothing when the payload carries no embed model", async () => {
    sentJobs.length = 0;
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: recordingBoss });
    expect(sentJobs).toEqual([]);
  });

  it("batches inserts for a document producing more than 5,000 chunks, all inside one transaction", async () => {
    // Own project: a chunk set chunks every ready document in its project, so this document must
    // not share the outer describe block's project (with "a.md") or its chunks would be mixed in
    // and the exact-count assertion below would be wrong.
    // 65,535 bind-param cap / 6 params per chunk row means a single INSERT statement tops out
    // around 10,922 rows; batching at 5,000 keeps a comfortable margin and forces at least three
    // batches for this document.
    const [bigProject] = await ctx.db.insert(projects).values({ organizationId: orgId, name: "big-proj" }).returning();
    const wordCount = 12_000;
    const bigText = Array.from({ length: wordCount }, (_, i) => `w${i}`).join(" ");
    await ctx.db.insert(documents).values({
      projectId: bigProject.id, filename: "big.md", mime: "text/markdown", contentHash: "h-big", status: "ready",
      text: bigText,
    });
    const bigParams = { maxTokens: 1, overlapTokens: 0 };
    const [bigSet] = await ctx.db.insert(chunkSets).values({
      projectId: bigProject.id, chunker: "fixed", params: bigParams, paramsHash: hashParams(bigParams),
    }).returning();

    await chunkHandler({ chunkSetId: bigSet.id }, { db: ctx.db, boss: recordingBoss });

    const rows = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, bigSet.id));
    expect(rows.length).toBe(wordCount);
    const idxs = rows.map((r) => r.idx).sort((a, b) => a - b);
    expect(idxs).toEqual(Array.from({ length: wordCount }, (_, i) => i));
  });

  it("chains the embed job after the rebuild has committed", async () => {
    sentJobs.length = 0;
    await chunkHandler(
      { chunkSetId: setId, embedModel: "mock-embedding", organizationId: orgId },
      { db: ctx.db, boss: recordingBoss },
    );
    expect(sentJobs).toHaveLength(1);
    const [job] = sentJobs;
    expect(job.name).toBe("embed");
    expect(job.data).toEqual({ chunkSetId: setId, model: "mock-embedding", organizationId: orgId });
    expect(job.opts).toEqual({ singletonKey: `${setId}:mock-embedding` });
    // The whole point of chaining: the chunks the embed job will read are already committed.
    expect(job.chunksVisible).toBeGreaterThan(0);
  });
});

describe("embedHandler", () => {
  it("embeds all chunks with the mock model and meters usage", async () => {
    await embedHandler({ chunkSetId: setId, model: "mock-embedding", organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
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
    await embedHandler({ chunkSetId: setId, model: "mock-embedding", organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    expect((await ctx.db.select().from(chunkEmbeddings)).length).toBe(before);
  });
});
