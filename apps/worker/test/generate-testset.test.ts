import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDb, organizations, projects, documents, testSets, testQuestions, usageLog,
} from "@ragbench/db";
import { normalizeWs } from "@ragbench/core";
import { generateTestsetHandler } from "../src/handlers/generate-testset";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
let ctx: ReturnType<typeof createDb>;
let orgId: string;

// The handler never enqueues anything, but JobHandler's context requires a boss.
const noopBoss = { async send() { return "job-1"; } } as never;

/**
 * Long enough (>1200 chars, the default passage window) that samplePassages returns more than one
 * passage per document -- otherwise a short document is a single passage and the round-robin across
 * documents has nothing to alternate over. Every sentence clears mockGenerateQa's 30-char floor.
 */
function longText(topic: string, sentences = 24): string {
  return Array.from(
    { length: sentences },
    (_, i) => `The ${topic} report section ${i} records that measurement number ${i} was observed by the field team.`,
  ).join(" ");
}

async function seedProject(name: string, docTexts: string[]): Promise<string> {
  const [proj] = await ctx.db.insert(projects).values({ organizationId: orgId, name }).returning();
  for (const [i, text] of docTexts.entries()) {
    await ctx.db.insert(documents).values({
      projectId: proj.id, filename: `${name}-${i}.md`, mime: "text/markdown",
      contentHash: `${name}-h${i}`, status: "ready", text,
    });
  }
  return proj.id;
}

async function makeSet(projectId: string, questionsTarget: number, generatorModel = "mock-llm"): Promise<string> {
  const [set] = await ctx.db.insert(testSets).values({
    projectId, name: "set", generatorModel, questionsTarget,
  }).returning();
  return set.id;
}

function activeQuestions(testSetId: string) {
  return ctx.db.select().from(testQuestions)
    .where(and(eq(testQuestions.testSetId, testSetId), eq(testQuestions.status, "active")));
}

async function loadSet(testSetId: string) {
  const [row] = await ctx.db.select().from(testSets).where(eq(testSets.id, testSetId));
  return row;
}

beforeAll(async () => {
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "gts-org" }).returning();
  orgId = org.id;
});
afterAll(async () => { await ctx.pool.end(); });

describe("generateTestsetHandler", () => {
  it("generates verified questions across documents and marks the set ready", async () => {
    const projectId = await seedProject("gts-happy", [longText("alpha"), longText("beta")]);
    const testSetId = await makeSet(projectId, 6);

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    expect((await loadSet(testSetId)).status).toBe("ready");
    const rows = await activeQuestions(testSetId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(6);
    // Round-robin across documents: questions must not all come from the first document.
    expect(new Set(rows.map((r) => r.documentId)).size).toBe(2);

    const docs = await ctx.db.select().from(documents).where(eq(documents.projectId, projectId));
    for (const row of rows) {
      const doc = docs.find((d) => d.id === row.documentId);
      expect(doc?.text).toBeTruthy();
      const docText = doc!.text!;
      // The gold-span invariant: the span indexes the DOCUMENT's text (not the passage's), and the
      // text it selects is the gold answer up to whitespace normalization.
      expect(row.goldStart).toBeGreaterThanOrEqual(0);
      expect(row.goldEnd).toBeGreaterThan(row.goldStart);
      expect(row.goldEnd).toBeLessThanOrEqual(docText.length);
      expect(normalizeWs(docText.slice(row.goldStart, row.goldEnd))).toBe(normalizeWs(row.goldAnswer));
      expect(row.question.length).toBeGreaterThan(0);
    }

    // Demo generation is a pure function: it must never bill the org against a real provider.
    const usage = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    expect(usage.every((u) => u.provider === "mock")).toBe(true);
  });

  it("is a no-op on retry once the set is ready", async () => {
    const projectId = await seedProject("gts-retry", [longText("gamma"), longText("delta")]);
    const testSetId = await makeSet(projectId, 6);

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });
    const first = (await activeQuestions(testSetId)).length;
    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });
    const second = await activeQuestions(testSetId);

    expect(second.length).toBe(first);
    expect(second.length).toBeLessThanOrEqual(6);
    expect((await loadSet(testSetId)).status).toBe("ready");
  });

  it("resumes a half-finished set without exceeding the target", async () => {
    const projectId = await seedProject("gts-resume", [longText("epsilon"), longText("zeta")]);
    const testSetId = await makeSet(projectId, 6);

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });
    const afterFirst = (await activeQuestions(testSetId)).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Simulate a crash after some questions were inserted but before the set was marked ready:
    // pg-boss re-runs the job against a set still in "generating".
    await ctx.db.update(testSets).set({ status: "generating" }).where(eq(testSets.id, testSetId));
    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    const afterSecond = await activeQuestions(testSetId);
    expect(afterSecond.length).toBeGreaterThanOrEqual(afterFirst);
    expect(afterSecond.length).toBeLessThanOrEqual(6);
    // The resume re-walks the same passages, so it must not re-store the questions it already has.
    expect(new Set(afterSecond.map((r) => r.question)).size).toBe(afterSecond.length);
    expect((await loadSet(testSetId)).status).toBe("ready");
  });

  it("generates nothing when the target is already met", async () => {
    const projectId = await seedProject("gts-met", [longText("eta")]);
    const testSetId = await makeSet(projectId, 2);
    const [doc] = await ctx.db.select().from(documents).where(eq(documents.projectId, projectId));
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert(testQuestions).values({
        testSetId, documentId: doc.id, question: `seeded ${i}?`, goldAnswer: "seeded", goldStart: 0, goldEnd: 6,
      });
    }

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    expect((await activeQuestions(testSetId)).length).toBe(3);
    expect((await loadSet(testSetId)).status).toBe("ready");
  });

  it("fails the set when the project has no ready documents", async () => {
    const [proj] = await ctx.db.insert(projects).values({ organizationId: orgId, name: "gts-empty" }).returning();
    await ctx.db.insert(documents).values({
      projectId: proj.id, filename: "broken.md", mime: "text/markdown", contentHash: "gts-e0",
      status: "failed", text: null,
    });
    // A "ready" document whose text never landed must not count either.
    await ctx.db.insert(documents).values({
      projectId: proj.id, filename: "textless.md", mime: "text/markdown", contentHash: "gts-e1",
      status: "ready", text: null,
    });
    const testSetId = await makeSet(proj.id, 6);

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    const set = await loadSet(testSetId);
    expect(set.status).toBe("failed");
    expect(set.error).toBe("no ready documents");
    expect(await activeQuestions(testSetId)).toHaveLength(0);
  });

  it("fails the set when the generator model is not in the registry", async () => {
    const projectId = await seedProject("gts-badmodel", [longText("theta")]);
    const testSetId = await makeSet(projectId, 2, "no-such-model");

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    const set = await loadSet(testSetId);
    expect(set.status).toBe("failed");
    expect(set.error).toContain("no-such-model");
  });

  it("resolves without throwing when the test set is gone", async () => {
    await expect(generateTestsetHandler(
      { testSetId: "00000000-0000-0000-0000-000000000000", organizationId: orgId },
      { db: ctx.db, boss: noopBoss },
    )).resolves.toBeUndefined();
  });
});
