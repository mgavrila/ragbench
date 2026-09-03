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
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: null as never });
    const rows = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId));
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r.documentId)).size).toBe(1); // only the ready doc
  });

  it("is idempotent (re-run replaces, not duplicates)", async () => {
    const before = (await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId))).length;
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: null as never });
    const after = (await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, setId))).length;
    expect(after).toBe(before);
  });
});

describe("embedHandler", () => {
  it("embeds all chunks with the mock model and meters usage", async () => {
    await embedHandler({ chunkSetId: setId, model: "mock-embedding", organizationId: orgId }, { db: ctx.db, boss: null as never });
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
    await embedHandler({ chunkSetId: setId, model: "mock-embedding", organizationId: orgId }, { db: ctx.db, boss: null as never });
    expect((await ctx.db.select().from(chunkEmbeddings)).length).toBe(before);
  });
});
