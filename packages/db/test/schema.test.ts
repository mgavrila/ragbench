import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb } from "../src/client";
import { organizations, projects, chunkEmbeddings, chunkSets, chunks, documents, testSets } from "../src/schema";

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

  it("cascades document deletion through chunks to embeddings", async () => {
    const [org] = await ctx.db.insert(organizations).values({ name: "cascade-org" }).returning();
    const [proj] = await ctx.db.insert(projects).values({ organizationId: org.id, name: "cascade-proj" }).returning();
    const [doc] = await ctx.db.insert(documents).values({
      projectId: proj.id, filename: "c.md", mime: "text/markdown", contentHash: "ch", text: "hello", status: "ready",
    }).returning();
    const [set] = await ctx.db.insert(chunkSets).values({
      projectId: proj.id, chunker: "fixed", params: { size: 1 }, paramsHash: "cph",
    }).returning();
    const [chunk] = await ctx.db.insert(chunks).values({
      chunkSetId: set.id, documentId: doc.id, idx: 0, text: "hello", startOffset: 0, endOffset: 5,
    }).returning();
    await ctx.db.insert(chunkEmbeddings).values({ chunkId: chunk.id, model: "mock-embedding", dimension: 3, embedding: [1, 0, 0] });

    await ctx.db.delete(documents).where(eq(documents.id, doc.id));
    expect(await ctx.db.select().from(chunks).where(eq(chunks.documentId, doc.id))).toHaveLength(0);
    expect(await ctx.db.select().from(chunkEmbeddings).where(eq(chunkEmbeddings.chunkId, chunk.id))).toHaveLength(0);
  });

  it("defaults test_sets status/questionsTarget and allows a null error", async () => {
    const [org] = await ctx.db.insert(organizations).values({ name: "ts-org" }).returning();
    const [proj] = await ctx.db.insert(projects).values({ organizationId: org.id, name: "ts-proj" }).returning();
    const [set] = await ctx.db.insert(testSets).values({
      projectId: proj.id, name: "smoke", generatorModel: "mock-generator",
    }).returning();
    expect(set.status).toBe("generating");
    expect(set.error).toBeNull();
    expect(set.questionsTarget).toBe(30);
  });

  it("accepts a docsFingerprint on chunk_sets", async () => {
    const [org] = await ctx.db.insert(organizations).values({ name: "fp-org" }).returning();
    const [proj] = await ctx.db.insert(projects).values({ organizationId: org.id, name: "fp-proj" }).returning();
    const [set] = await ctx.db.insert(chunkSets).values({
      projectId: proj.id, chunker: "fixed", params: { size: 1 }, paramsHash: "fp-hash",
      docsFingerprint: "abc123",
    }).returning();
    expect(set.docsFingerprint).toBe("abc123");

    const [row] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, set.id));
    expect(row.docsFingerprint).toBe("abc123");
  });
});
