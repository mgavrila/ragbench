import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, organizations, projects, documents, documentPath } from "@ragbench/db";
import { parseHandler } from "../src/handlers/parse";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let ctx: ReturnType<typeof createDb>;
let projectId: string;

beforeAll(async () => {
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "parse-org" }).returning();
  const [proj] = await ctx.db.insert(projects).values({ organizationId: org.id, name: "parse-proj" }).returning();
  projectId = proj.id;
});
afterAll(async () => { await ctx.pool.end(); });

async function makeDoc(filename: string, mime: string, fixture?: string) {
  const [doc] = await ctx.db.insert(documents).values({
    projectId, filename, mime, contentHash: "pending", status: "parsing",
  }).returning();
  if (fixture) {
    mkdirSync(dirname(documentPath(doc.id)), { recursive: true });
    copyFileSync(join(FIXTURES, fixture), documentPath(doc.id));
  }
  return doc;
}

describe("parseHandler", () => {
  it("parses markdown to ready with text and content hash", async () => {
    const doc = await makeDoc("sample.md", "text/markdown", "sample.md");
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("ready");
    expect(row.text).toContain("RAGBench markdown fixture body");
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses PDF text", async () => {
    const doc = await makeDoc("sample.pdf", "application/pdf", "sample.pdf");
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("ready");
    expect(row.text).toContain("RAGBench fixture PDF");
  });

  it("marks unreadable files failed without throwing", async () => {
    const doc = await makeDoc("ghost.pdf", "application/pdf"); // no file on disk
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
  });

  it("is a no-op for unknown document ids", async () => {
    await expect(parseHandler({ documentId: "00000000-0000-0000-0000-000000000000" }, { db: ctx.db, boss: null as never })).resolves.toBeUndefined();
  });
});
