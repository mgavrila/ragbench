import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb, chunkSets, documents, evalRuns, organizations, projects, testSets,
} from "@ragbench/db";
import { reconcileHandler } from "../src/handlers/reconcile";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test";
let ctx: ReturnType<typeof createDb>;
let orgId: string;
let projectId: string;

// A real pg-boss instance, used only to make the queues named below exist (job.name and
// schedule.name both carry a foreign key to queue.name -- see plans.js) and to plant jobs that
// reconcileHandler's "is there still a live job for this row" query must see. Nothing ever calls
// .work() on it, so a planted job sits in `created` state forever instead of being consumed --
// exactly the "still in flight" state these tests need to hold still.
let liveBoss: PgBoss;
const RECONCILE_QUEUES = ["evaluate-question", "chunk", "embed", "parse", "start-run"];

/** What reconcileHandler is given as `boss`: records every send instead of running anything, so a
 * re-enqueued start-run job is observable without a consumer racing to complete it mid-test. */
type Sent = { name: string; data: unknown; opts: unknown };
let sent: Sent[];
const recordingBoss = {
  async send(name: string, data: unknown, opts: unknown) {
    sent.push({ name, data, opts });
    return "job-1";
  },
} as never;

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}
function hoursAgo(n: number): Date {
  return minutesAgo(n * 60);
}

async function run(overrides: Partial<{
  status: string; totalJobs: number; completedJobs: number; createdAt: Date;
}> = {}) {
  const [testSet] = await ctx.db.insert(testSets)
    .values({ projectId, name: "ts", generatorModel: "mock" }).returning();
  const [row] = await ctx.db.insert(evalRuns).values({
    projectId, testSetId: testSet.id, mode: "retrieval-only",
    status: "running", totalJobs: 4, completedJobs: 1, createdAt: minutesAgo(11),
    ...overrides,
  }).returning();
  return row;
}

async function chunkSet(overrides: Partial<{ createdAt: Date; docsFingerprint: string | null }> = {}) {
  const params = { maxTokens: 100 };
  const [row] = await ctx.db.insert(chunkSets).values({
    // paramsHash only needs to be unique per (project, chunker) here, not a real hash.
    projectId, chunker: "fixed", params, paramsHash: `h${Math.random()}`,
    docsFingerprint: null, createdAt: minutesAgo(16),
    ...overrides,
  }).returning();
  return row;
}

async function document(overrides: Partial<{ createdAt: Date; status: string }> = {}) {
  const [row] = await ctx.db.insert(documents).values({
    projectId, filename: `d${Math.random()}.md`, mime: "text/markdown",
    contentHash: `h${Math.random()}`, status: "parsing", createdAt: minutesAgo(16),
    ...overrides,
  }).returning();
  return row;
}

beforeAll(async () => {
  ctx = createDb(URL);
  liveBoss = new PgBoss(URL);
  await liveBoss.start();
  for (const name of RECONCILE_QUEUES) {
    await liveBoss.createQueue(name, { retryLimit: 3, retryBackoff: true, policy: "exclusive" });
  }
  const [org] = await ctx.db.insert(organizations).values({ name: "reconcile-org" }).returning();
  orgId = org.id;
  const [project] = await ctx.db.insert(projects).values({ organizationId: orgId, name: "reconcile-proj" }).returning();
  projectId = project.id;
});

afterAll(async () => {
  for (const name of RECONCILE_QUEUES) await liveBoss.deleteAllJobs(name);
  await liveBoss.stop({ graceful: false });
});

describe("reconcileHandler", () => {
  describe("stuck runs", () => {
    it("re-enqueues start-run for a run stuck running with no active evaluate-question jobs", async () => {
      sent = [];
      const r = await run();
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      // Filtered by runId, not asserted as the whole `sent` array: other stuck-run rows left behind
      // by earlier tests in this shared database are swept up by the same reconcile pass and would
      // otherwise make this assertion depend on test order.
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toEqual([
        { name: "start-run", data: { runId: r.id, organizationId: orgId }, opts: { singletonKey: r.id } },
      ]);
    });

    it("does not re-enqueue when an evaluate-question job is still live for the run", async () => {
      sent = [];
      const r = await run();
      await liveBoss.send("evaluate-question", { runId: r.id }, { singletonKey: `${r.id}:live` });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toEqual([]);
    });

    it("does not re-enqueue a run whose jobs have all completed", async () => {
      sent = [];
      const r = await run({ totalJobs: 4, completedJobs: 4 });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toEqual([]);
    });

    it("does not re-enqueue a run still comfortably inside the stuck window", async () => {
      sent = [];
      const r = await run({ createdAt: minutesAgo(2) });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toEqual([]);
    });
  });

  describe("abandoned runs (past the 24h bound)", () => {
    it("fails a running run past 24h with no live jobs instead of re-enqueuing", async () => {
      sent = [];
      const r = await run({ createdAt: hoursAgo(25) });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, r.id));
      expect(after.status).toBe("failed");
      expect(after.error).toMatch(/did not complete within 24h/i);
      expect(after.error).toMatch(/1 of 4 jobs finished/);
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toEqual([]);
    });

    it("still re-enqueues an 11-minute-old run rather than failing it", async () => {
      // Guards against an off-by-scope bug in the 24h check swallowing the ordinary stuck-run path.
      sent = [];
      const r = await run();
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, r.id));
      expect(after.status).toBe("running");
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toHaveLength(1);
    });
  });

  describe("stuck pending runs", () => {
    it("re-enqueues start-run for a run stuck pending with no live start-run job", async () => {
      sent = [];
      const r = await run({ status: "pending", createdAt: minutesAgo(11) });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toEqual([
        { name: "start-run", data: { runId: r.id, organizationId: orgId }, opts: { singletonKey: r.id } },
      ]);
    });

    it("does not re-enqueue when a start-run job is still live for the run", async () => {
      sent = [];
      const r = await run({ status: "pending", createdAt: minutesAgo(11) });
      await liveBoss.send("start-run", { runId: r.id }, { singletonKey: `${r.id}:live` });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toEqual([]);
    });

    it("fails a pending run past 24h with no live start-run job instead of re-enqueuing", async () => {
      sent = [];
      const r = await run({ status: "pending", createdAt: hoursAgo(25) });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, r.id));
      expect(after.status).toBe("failed");
      expect(after.error).toMatch(/did not start within 24h/i);
      expect(sent.filter((s) => (s.data as { runId?: string }).runId === r.id)).toEqual([]);
    });
  });

  describe("stuck chunk sets", () => {
    it("marks a chunk set stuck building with an advisory embedError", async () => {
      const set = await chunkSet();
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, set.id));
      expect(after.embedError).toMatch(/did not complete/i);
    });

    it("leaves a chunk set alone while a chunk job is still live for it", async () => {
      const set = await chunkSet();
      await liveBoss.send("chunk", { chunkSetId: set.id }, { singletonKey: `${set.id}:live` });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, set.id));
      expect(after.embedError).toBeNull();
    });

    it("leaves a chunk set alone while an embed job is still live for it", async () => {
      const set = await chunkSet();
      await liveBoss.send("embed", { chunkSetId: set.id }, { singletonKey: `${set.id}:live` });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, set.id));
      expect(after.embedError).toBeNull();
    });

    it("leaves a chunk set alone once it has finished at least one build", async () => {
      const set = await chunkSet({ docsFingerprint: "done" });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, set.id));
      expect(after.embedError).toBeNull();
    });
  });

  describe("stuck documents", () => {
    it("fails a document stuck parsing with no live parse job", async () => {
      const doc = await document();
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
      expect(after.status).toBe("failed");
      expect(after.error).toMatch(/did not complete/i);
    });

    it("leaves a document alone while a parse job is still live for it", async () => {
      const doc = await document();
      await liveBoss.send("parse", { documentId: doc.id }, { singletonKey: `${doc.id}:live` });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
      expect(after.status).toBe("parsing");
    });

    it("leaves a recently-created parsing document alone", async () => {
      const doc = await document({ createdAt: minutesAgo(2) });
      await reconcileHandler({}, { db: ctx.db, boss: recordingBoss });
      const [after] = await ctx.db.select().from(documents).where(eq(documents.id, doc.id));
      expect(after.status).toBe("parsing");
    });
  });
});
