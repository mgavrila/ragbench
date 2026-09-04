import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  createDb, organizations, projects, documents, chunkSets, chunks, chunkEmbeddings, usageLog,
} from "@ragbench/db";
import { hashParams, makeEmbedder, ProviderError } from "@ragbench/core";
import { chunkHandler } from "../src/handlers/chunk";
import { embedHandler } from "../src/handlers/embed";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test";
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

  // Simulates reconcile.ts's stuck-build advisory (see reconcile.ts): forcing a fingerprint
  // mismatch is what makes chunkHandler actually re-run its build transaction rather than take the
  // no-op skip path the "is idempotent" test above exercises -- that skip path never touches
  // embedError, so a stale error from a set that got flagged and later recovered would otherwise
  // never clear.
  it("clears a stale embedError once a rebuild actually completes", async () => {
    await ctx.db.update(chunkSets)
      .set({ docsFingerprint: "stale-forces-rebuild", embedError: "build did not complete" })
      .where(eq(chunkSets.id, setId));
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: recordingBoss });
    const [after] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, setId));
    expect(after.embedError).toBeNull();
  });

  it("enqueues nothing when the set has no embed models recorded", async () => {
    sentJobs.length = 0;
    await chunkHandler({ chunkSetId: setId, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    expect(sentJobs).toEqual([]);
  });

  it("enqueues nothing without an organizationId, even if the set has embed models recorded", async () => {
    await ctx.db.update(chunkSets).set({ embedModels: ["mock-embedding"] }).where(eq(chunkSets.id, setId));
    sentJobs.length = 0;
    await chunkHandler({ chunkSetId: setId }, { db: ctx.db, boss: recordingBoss });
    expect(sentJobs).toEqual([]);
    await ctx.db.update(chunkSets).set({ embedModels: [] }).where(eq(chunkSets.id, setId)); // reset for later tests
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

  it("chains one embed job per model recorded on the set, read fresh after the rebuild commits", async () => {
    // The chunk-sets route is what normally appends to embedModels; a direct update stands in for
    // it here, and two models prove chunkHandler chains all of them, not just the payload's (there
    // is no embedModel in the payload anymore).
    await ctx.db.update(chunkSets).set({ embedModels: ["mock-embedding", "text-embedding-3-small"] })
      .where(eq(chunkSets.id, setId));
    sentJobs.length = 0;
    await chunkHandler({ chunkSetId: setId, organizationId: orgId }, { db: ctx.db, boss: recordingBoss });
    expect(sentJobs).toHaveLength(2);
    expect(sentJobs.map((j) => j.name)).toEqual(["embed", "embed"]);
    expect(sentJobs.map((j) => j.data)).toEqual([
      { chunkSetId: setId, model: "mock-embedding", organizationId: orgId },
      { chunkSetId: setId, model: "text-embedding-3-small", organizationId: orgId },
    ]);
    expect(sentJobs.map((j) => j.opts)).toEqual([
      { singletonKey: `${setId}:mock-embedding` },
      { singletonKey: `${setId}:text-embedding-3-small` },
    ]);
    // The whole point of chaining: the chunks the embed jobs will read are already committed.
    expect(sentJobs.every((j) => j.chunksVisible > 0)).toBe(true);

    await ctx.db.update(chunkSets).set({ embedModels: ["mock-embedding"] }).where(eq(chunkSets.id, setId));
  });
});

describe("chunkHandler rebuild-skip", () => {
  it("skips teardown when nothing changed since the last rebuild, but still chains embed", async () => {
    const [proj] = await ctx.db.insert(projects).values({ organizationId: orgId, name: "skip-proj" }).returning();
    await ctx.db.insert(documents).values({
      projectId: proj.id, filename: "s1.md", mime: "text/markdown", contentHash: "skip-h1", status: "ready",
      text: "one two three four five six seven eight",
    });
    const params = { maxTokens: 4, overlapTokens: 1 };
    const [set] = await ctx.db.insert(chunkSets).values({
      projectId: proj.id, chunker: "fixed", params, paramsHash: hashParams(params),
    }).returning();

    await chunkHandler({ chunkSetId: set.id }, { db: ctx.db, boss: recordingBoss });
    const first = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, set.id));
    expect(first.length).toBeGreaterThan(0);
    const firstIds = first.map((c) => c.id).sort();
    const [setRowAfterFirst] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, set.id));
    expect(setRowAfterFirst.docsFingerprint).not.toBeNull();

    await ctx.db.update(chunkSets).set({ embedModels: ["mock-embedding"] }).where(eq(chunkSets.id, set.id));
    sentJobs.length = 0;
    await chunkHandler(
      { chunkSetId: set.id, organizationId: orgId },
      { db: ctx.db, boss: recordingBoss },
    );

    const second = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, set.id));
    // No teardown happened: the exact same rows (same IDs) are still there.
    expect(second.map((c) => c.id).sort()).toEqual(firstIds);
    // The embed chain still fires on a skipped rebuild.
    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0].name).toBe("embed");
    expect(sentJobs[0].data).toEqual({ chunkSetId: set.id, model: "mock-embedding", organizationId: orgId });
  });

  it("rebuilds when a document becomes ready, changing the fingerprint", async () => {
    const [proj] = await ctx.db.insert(projects).values({ organizationId: orgId, name: "skip-proj-2" }).returning();
    await ctx.db.insert(documents).values({
      projectId: proj.id, filename: "r1.md", mime: "text/markdown", contentHash: "reb-h1", status: "ready",
      text: "one two three four five six seven eight",
    });
    const [pendingDoc] = await ctx.db.insert(documents).values({
      projectId: proj.id, filename: "r2.md", mime: "text/markdown", contentHash: "reb-h2", status: "parsing",
      text: "nine ten eleven twelve thirteen fourteen",
    }).returning();
    const params = { maxTokens: 4, overlapTokens: 1 };
    const [set] = await ctx.db.insert(chunkSets).values({
      projectId: proj.id, chunker: "fixed", params, paramsHash: hashParams(params),
    }).returning();

    await chunkHandler({ chunkSetId: set.id }, { db: ctx.db, boss: recordingBoss });
    const first = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, set.id));
    const firstIds = first.map((c) => c.id).sort();
    const [setRowBefore] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, set.id));
    const fingerprintBefore = setRowBefore.docsFingerprint;

    await ctx.db.update(documents).set({ status: "ready" }).where(eq(documents.id, pendingDoc.id));
    await chunkHandler({ chunkSetId: set.id }, { db: ctx.db, boss: recordingBoss });

    const second = await ctx.db.select().from(chunks).where(eq(chunks.chunkSetId, set.id));
    expect(second.map((c) => c.id).sort()).not.toEqual(firstIds); // teardown happened: fresh row IDs
    expect(new Set(second.map((c) => c.documentId)).size).toBe(2); // both docs now chunked

    const [setRowAfter] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, set.id));
    expect(setRowAfter.docsFingerprint).not.toBe(fingerprintBefore);
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

describe("embedHandler failure visibility", () => {
  // A stub embedder, injected via embedHandler's third (test-only) parameter: the real provider
  // SDKs don't fail deterministically without network or valid-looking credentials, so a poisoned
  // stub is what stands in for "a provider call that fails" here.
  const poisoned = (err: Error): typeof makeEmbedder => () => ({
    model: "poison", dimension: 3,
    async embed(): Promise<number[][]> { throw err; },
  });

  // A model distinct from "mock-embedding" (already fully embedded for setId by the describe
  // block above) so `pending` is non-empty and the stub's embed() actually gets called.
  const poisonModel = "text-embedding-3-small";

  it("marks chunkSets.embedError, model-prefixed, on a non-retryable provider failure, without throwing", async () => {
    const err = new ProviderError("auth", "poison", "no credentials");
    await expect(embedHandler(
      { chunkSetId: setId, model: poisonModel, organizationId: orgId },
      { db: ctx.db, boss: recordingBoss },
      poisoned(err),
    )).resolves.toBeUndefined();

    const [row] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, setId));
    expect(row.embedError).toBe(`${poisonModel}: no credentials`);
  });

  it("rethrows a retryable provider failure and leaves embedError untouched for pg-boss to retry", async () => {
    await ctx.db.update(chunkSets).set({ embedError: null }).where(eq(chunkSets.id, setId));
    const err = new ProviderError("rate_limit", "poison", "slow down");

    await expect(embedHandler(
      { chunkSetId: setId, model: poisonModel, organizationId: orgId },
      { db: ctx.db, boss: recordingBoss },
      poisoned(err),
    )).rejects.toThrow("slow down");

    const [row] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, setId));
    expect(row.embedError).toBeNull();
  });

  it("propagates a failure that is not a ProviderError untouched (a DB fault, a bug), never as embedError", async () => {
    const bug = new TypeError("undefined is not a function");
    await expect(embedHandler(
      { chunkSetId: setId, model: poisonModel, organizationId: orgId },
      { db: ctx.db, boss: recordingBoss },
      poisoned(bug),
    )).rejects.toThrow(bug);

    const [row] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, setId));
    expect(row.embedError).toBeNull();
  });

  it("clears an existing embedError on the next successful embed", async () => {
    await ctx.db.update(chunkSets).set({ embedError: "mock-embedding: stale failure" }).where(eq(chunkSets.id, setId));

    await embedHandler({ chunkSetId: setId, model: "mock-embedding", organizationId: orgId }, { db: ctx.db, boss: recordingBoss });

    const [row] = await ctx.db.select().from(chunkSets).where(eq(chunkSets.id, setId));
    expect(row.embedError).toBeNull();
  });
});
