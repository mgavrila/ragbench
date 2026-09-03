import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb } from "../src/client";
import { organizations, projects, chunkEmbeddings, chunkSets, chunks, documents } from "../src/schema";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
let ctx: Awaited<ReturnType<typeof createDb>>;

beforeAll(async () => {
  await migrateDb(URL);
  ctx = createDb(URL);
});
afterAll(async () => {
  await ctx.pool.end();
});

describe("schema", () => {
  it("migrates and supports the org -> project chain", async () => {
    const [org] = await ctx.db.insert(organizations).values({ name: "t-org" }).returning();
    const [proj] = await ctx.db.insert(projects).values({ organizationId: org.id, name: "t-proj" }).returning();
    expect(proj.organizationId).toBe(org.id);
  });

  it("round-trips a vector embedding", async () => {
    const [org] = await ctx.db.insert(organizations).values({ name: "v-org" }).returning();
    const [proj] = await ctx.db.insert(projects).values({ organizationId: org.id, name: "v-proj" }).returning();
    const [doc] = await ctx.db.insert(documents).values({
      projectId: proj.id, filename: "a.md", mime: "text/markdown",
      contentHash: "h1", text: "hello world", status: "ready",
    }).returning();
    const [set] = await ctx.db.insert(chunkSets).values({
      projectId: proj.id, chunker: "fixed", params: { size: 512 }, paramsHash: "p1",
    }).returning();
    const [chunk] = await ctx.db.insert(chunks).values({
      chunkSetId: set.id, documentId: doc.id, idx: 0, text: "hello world", startOffset: 0, endOffset: 11,
    }).returning();
    const emb = [0.1, 0.2, 0.3];
    await ctx.db.insert(chunkEmbeddings).values({
      chunkId: chunk.id, model: "mock-embedding", dimension: 3, embedding: emb,
    });
    const [row] = await ctx.db.select().from(chunkEmbeddings)
      .where(eq(chunkEmbeddings.chunkId, chunk.id));
    expect(row.embedding).toHaveLength(3);
    expect(row.embedding[0]).toBeCloseTo(0.1);
  });
});
