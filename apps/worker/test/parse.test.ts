import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, organizations, projects, documents, documentPath } from "@ragbench/db";
import { parseHandler, sanitizeExtractedText } from "../src/handlers/parse";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let ctx: ReturnType<typeof createDb>;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "parse-org" }).returning();
  orgId = org.id;
  const [proj] = await ctx.db.insert(projects).values({ organizationId: orgId, name: "parse-proj" }).returning();
  projectId = proj.id;
});
afterAll(async () => { await ctx.pool.end(); });

/**
 * Duplicate detection is scoped per-project, and the shared `projectId` above accumulates ready
 * documents across the whole file (e.g. the sample.md and sample.pdf fixtures reused by several
 * tests). A test that cares about content-hash uniqueness needs its own project so it isn't
 * accidentally flagged duplicate against an unrelated test's fixture.
 */
async function makeProject() {
  const [proj] = await ctx.db.insert(projects).values({ organizationId: orgId, name: `parse-proj-${crypto.randomUUID()}` }).returning();
  return proj.id;
}

async function makeDoc(filename: string, mime: string, fixture?: string, pid: string = projectId) {
  const [doc] = await ctx.db.insert(documents).values({
    projectId: pid, filename, mime, contentHash: "pending", status: "parsing",
  }).returning();
  if (fixture) {
    mkdirSync(dirname(documentPath(doc.id)), { recursive: true });
    copyFileSync(join(FIXTURES, fixture), documentPath(doc.id));
  }
  return doc;
}

/** Same as makeDoc but writes raw bytes, for content the fixtures directory should not carry. */
async function makeDocWithBytes(filename: string, mime: string, bytes: Buffer) {
  const doc = await makeDoc(filename, mime);
  mkdirSync(dirname(documentPath(doc.id)), { recursive: true });
  writeFileSync(documentPath(doc.id), bytes);
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

  it("fails binary content uploaded under a text mime instead of storing mojibake", async () => {
    const binary = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
    const doc = await makeDocWithBytes("payload.txt", "text/plain", binary);
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("does not appear to be text");
  });

  it("strips stray NUL bytes from otherwise valid text", async () => {
    const withNul = Buffer.from(`before${String.fromCharCode(0)}after, plus a normal sentence.`, "utf-8");
    const doc = await makeDocWithBytes("nul.md", "text/markdown", withNul);
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    // Postgres refuses NUL in a text column, so leaving it in would have failed this update.
    expect(row.status).toBe("ready");
    expect(row.text).toBe("beforeafter, plus a normal sentence.");
  });

  it("parses a PDF whose declared mime is text/plain", async () => {
    // Own project: this fixture's bytes are identical to the "parses PDF text" test's sample.pdf,
    // and duplicate detection is scoped per-project, so sharing the project would wrongly flag
    // this as a duplicate of that unrelated test's document.
    const pid = await makeProject();
    const doc = await makeDoc("mislabeled.pdf", "text/plain", "sample.pdf", pid);
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("ready");
    expect(row.text).toContain("RAGBench fixture PDF");
  });

  it("sanitizes NUL bytes from PDF-extracted text without checking printability (that branch shape)", () => {
    // Simulates the PDF branch: unpdf's extracted text can legitimately contain a stray NUL from
    // a malformed embedded font/stream, and unlike the text branch it must not be rejected on
    // printability -- it's already known to be a real PDF, not a mislabeled binary.
    const withNul = `before${String.fromCharCode(0)}after  mostly non-printable`;
    expect(sanitizeExtractedText(withNul, { checkPrintable: false })).toBe(
      "beforeafter  mostly non-printable",
    );
  });

  it("sanitizes and printability-checks the text branch shape", () => {
    expect(sanitizeExtractedText(`before${String.fromCharCode(0)}after, a normal sentence.`, { checkPrintable: true }))
      .toBe("beforeafter, a normal sentence.");
    const binary = Array.from({ length: 200 }, (_, i) => String.fromCharCode(i % 32)).join("");
    expect(() => sanitizeExtractedText(binary, { checkPrintable: true })).toThrow("does not appear to be text");
  });

  it("marks a document duplicate when another ready document in the project shares its content hash", async () => {
    const pid = await makeProject();
    const original = await makeDoc("original.md", "text/markdown", "sample.md", pid);
    await parseHandler({ documentId: original.id }, { db: ctx.db, boss: null as never });
    const [readyRow] = await ctx.db.select().from(documents).where(eq(documents.id, original.id));
    expect(readyRow.status).toBe("ready");

    const dupe = await makeDoc("copy.md", "text/markdown", "sample.md", pid);
    await parseHandler({ documentId: dupe.id }, { db: ctx.db, boss: null as never });
    const [dupeRow] = await ctx.db.select().from(documents).where(eq(documents.id, dupe.id));
    expect(dupeRow.status).toBe("duplicate");
    expect(dupeRow.error).toBe("duplicate of original.md");
    // Text is still stored even though the document is marked duplicate.
    expect(dupeRow.text).toContain("RAGBench markdown fixture body");
  });

  it("does not mark itself duplicate when re-parsed after already going ready (idempotent retry)", async () => {
    const pid = await makeProject();
    const doc = await makeDoc("solo.md", "text/markdown", "sample.md", pid);
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("ready");
  });

  it("does not mark a document duplicate against a non-ready document with the same hash", async () => {
    const pid = await makeProject();
    const failedTwin = await makeDoc("twin-failed.md", "text/markdown", undefined, pid);
    await ctx.db.update(documents)
      .set({ status: "failed", contentHash: "will-not-actually-match" })
      .where(eq(documents.id, failedTwin.id));
    const doc = await makeDoc("unique-vs-failed.md", "text/markdown", "sample.md", pid);
    await parseHandler({ documentId: doc.id }, { db: ctx.db, boss: null as never });
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("ready");
  });

  it("is a no-op for unknown document ids", async () => {
    await expect(parseHandler({ documentId: "00000000-0000-0000-0000-000000000000" }, { db: ctx.db, boss: null as never })).resolves.toBeUndefined();
  });

  it("propagates a DB error after successful extraction instead of mislabeling it a parse failure", async () => {
    const doc = await makeDoc("sample.md", "text/markdown", "sample.md");
    // Extraction succeeds; only the ready-update call fails. This must reject the handler (so
    // pg-boss retries the job) rather than being caught and written as status:"failed" -- a
    // transient DB error is not the same as a bad file.
    const failingDb = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === "update") throw new Error("simulated transient db error");
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      parseHandler({ documentId: doc.id }, { db: failingDb, boss: null as never }),
    ).rejects.toThrow("simulated transient db error");
    const [row] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.status).toBe("parsing"); // unchanged -- not mislabeled "failed"
  });
});
