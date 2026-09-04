import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDb, organizations, projects, documents, testSets, testQuestions, usageLog,
} from "@ragbench/db";
import { ProviderError, normalizeWs, samplePassages, type LLMProvider } from "@ragbench/core";
import {
  describeGeneration, generateTestsetHandler, passesTrivialityGate, roundRobinPassages,
} from "../src/handlers/generate-testset";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test";
let ctx: ReturnType<typeof createDb>;
let orgId: string;

// The handler never enqueues anything, but JobHandler's context requires a boss.
const noopBoss = { async send() { return "job-1"; } } as never;

/**
 * Long enough (>1200 chars, the default passage window) that samplePassages returns more than one
 * passage per document -- otherwise a short document is a single passage and the round-robin across
 * documents has nothing to alternate over. Every sentence clears mockGenerateQa's 30-char floor.
 * Sentence lengths deliberately vary (the trailing clause repeats 0-2 times), so the passage
 * windows land mid-sentence rather than tidily on a sentence boundary: that is what exercises the
 * well-formedness assertion on gold answers below.
 */
function longText(topic: string, sentences = 24): string {
  return Array.from({ length: sentences }, (_, i) =>
    `The ${topic} report section ${i} records that measurement ${i * 137} was observed by the field team`
    + `${" and reviewed by the reviewer".repeat(i % 3)}.`,
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

/**
 * Runs `fn` with no Anthropic credentials in the environment, restoring them afterwards. Tests that
 * prove "no provider call happened" only prove it when a call would actually have failed, and a
 * developer machine with a key would otherwise let a regression reach the real API.
 */
async function withoutAnthropicCredentials(fn: () => Promise<void>): Promise<void> {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    await fn();
  } finally {
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  }
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

describe("roundRobinPassages", () => {
  it("alternates documents rather than draining one at a time", () => {
    const docs = [{ id: "A", text: longText("alpha") }, { id: "B", text: longText("beta") }];

    const emitted = roundRobinPassages(docs, 6).map((p) => p.doc.id);

    expect(emitted.length).toBeGreaterThanOrEqual(4);
    expect(emitted.slice(0, 4)).toEqual(["A", "B", "A", "B"]);
  });

  it("keeps the alternation when one document runs out of passages", () => {
    // "B" fits in a single passage window, so after the first round only "A" has passages left.
    const docs = [{ id: "A", text: longText("alpha") }, { id: "B", text: "One short document." }];

    const emitted = roundRobinPassages(docs, 6).map((p) => p.doc.id);

    expect(emitted[0]).toBe("A");
    expect(emitted[1]).toBe("B");
    expect(emitted.slice(2).every((id) => id === "A")).toBe(true);
  });

  it("gives each document a share of the target rather than the whole of it", () => {
    const docs = [{ id: "A", text: longText("alpha", 200) }, { id: "B", text: longText("beta", 200) }];

    const emitted = roundRobinPassages(docs, 4);

    // Quota is ceil(4 / 2) = 2 passages per document from these long texts, not 4 each.
    expect(emitted.filter((p) => p.doc.id === "A")).toHaveLength(2);
    expect(emitted.filter((p) => p.doc.id === "B")).toHaveLength(2);
  });
});

describe("describeGeneration", () => {
  const noDrops = {
    verificationFailed: 0, answerNotInQuote: 0, alreadyAsked: 0, gateTrivial: 0, parseEmpty: 0,
  };

  it("reports the count alone when nothing was dropped", () => {
    expect(describeGeneration(6, 6, noDrops)).toBe("generated 6 of 6");
  });

  it("names every reason a candidate was dropped", () => {
    const text = describeGeneration(0, 10, {
      verificationFailed: 4, answerNotInQuote: 3, alreadyAsked: 5, gateTrivial: 2, parseEmpty: 1,
    });

    expect(text).toBe(
      "generated 0 of 10: 4 quotes failed verification, 3 answers were not inside their quote, "
      + "5 questions were already asked, 2 questions were dropped as trivial, 1 passage produced no candidates",
    );
  });

  it("lists only the reasons that actually fired", () => {
    expect(describeGeneration(1, 4, { ...noDrops, verificationFailed: 1 }))
      .toBe("generated 1 of 4: 1 quote failed verification");
  });

  it("uses the singular phrasing for a single repeat", () => {
    expect(describeGeneration(2, 3, { ...noDrops, alreadyAsked: 1 }))
      .toBe("generated 2 of 3: 1 question was already asked");
  });
});

describe("passesTrivialityGate", () => {
  // The gate is the one provider path with no keyless integration coverage, so it is exercised
  // directly through a stub rather than through the handler.
  const stubGate = (answer: string | Error): LLMProvider => ({
    model: "stub-gate",
    async complete() {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });

  it("drops a question the gate calls trivial", async () => {
    expect(await passesTrivialityGate(stubGate('{"trivial": true}'), "q?", "quote")).toBe(false);
  });

  it("keeps a question the gate clears", async () => {
    expect(await passesTrivialityGate(stubGate('{"trivial": false}'), "q?", "quote")).toBe(true);
  });

  it("keeps the question when the verdict cannot be parsed", async () => {
    expect(await passesTrivialityGate(stubGate("I'm not sure, honestly."), "q?", "quote")).toBe(true);
  });

  it("keeps the question when the gate provider is down, retryable or not", async () => {
    // The gate runs on a different model than the generator, so its outage must cost a few weak
    // questions -- not the generation run, and not the whole test set.
    const rateLimited = new ProviderError("rate_limit", "anthropic", "429 slow down");
    const dead = new ProviderError("auth", "anthropic", "401 no credentials");
    expect(rateLimited.retryable).toBe(true);
    expect(dead.retryable).toBe(false);

    expect(await passesTrivialityGate(stubGate(rateLimited), "q?", "quote")).toBe(true);
    expect(await passesTrivialityGate(stubGate(dead), "q?", "quote")).toBe(true);
  });

  it("propagates a failure that is not a provider failure", async () => {
    const bug = new TypeError("undefined is not a function");
    await expect(passesTrivialityGate(stubGate(bug), "q?", "quote")).rejects.toThrow(bug);
  });
});

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
      // Span-equals-answer is a property of the DEMO generator, which quotes the whole sentence it
      // answers with (answer === quote), and the span is cut from the quote. Production only
      // guarantees the weaker containment the handler enforces -- the answer sits inside the quote
      // the span points at -- so do not read this line as a promise about real generator output.
      expect(normalizeWs(docText.slice(row.goldStart, row.goldEnd))).toBe(normalizeWs(row.goldAnswer));
      expect(row.question.length).toBeGreaterThan(0);
      // Well-formedness: a gold answer starts where a sentence starts. Passages are cut on word
      // boundaries, so without care the passage that opens mid-sentence contributes its leading
      // fragment ("quantity reached level 161 during the trial.") as ground truth.
      const preceding = docText.slice(0, row.goldStart).trimEnd();
      expect(preceding === "" || /[.!?]$/.test(preceding)).toBe(true);
    }

    // The demo generator calls no provider, but it still meters: a demo run has to appear in the
    // usage view (with a zero cost) rather than leaving the org unable to tell "nothing ran" from
    // "nothing was recorded". The gate is skipped in demo mode, so it never bills.
    const usage = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    const metered = usage.filter((u) => u.purpose === "testset");
    expect(metered.length).toBeGreaterThan(0);
    for (const u of metered) {
      expect(u.provider).toBe("mock");
      expect(u.model).toBe("mock-llm");
      expect(u.costUsd).toBe(0);
      expect(u.inputTokens).toBeGreaterThan(0);
    }
    expect(usage.filter((u) => u.purpose === "testset-gate")).toHaveLength(0);
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
    // A real model with credentials stripped below: reaching the generator at all would throw, so
    // the set turning ready is proof that a met target short-circuits before any provider call.
    const testSetId = await makeSet(projectId, 2, "claude-opus-5");
    const [doc] = await ctx.db.select().from(documents).where(eq(documents.projectId, projectId));
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert(testQuestions).values({
        testSetId, documentId: doc.id, question: `seeded ${i}?`, goldAnswer: "seeded", goldStart: 0, goldEnd: 6,
      });
    }

    await withoutAnthropicCredentials(async () => {
      await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });
    });

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

  it("gives every document its own questions even when two documents are identical", async () => {
    // Parsing marks a re-uploaded file "duplicate", but two ready documents can still hold the
    // same text (different files, same content, seeded here directly). The demo generator derives
    // its question from the sentence, so both documents produce the exact same question strings --
    // they are still different documents with their own gold spans and must both be represented.
    const shared = longText("iota");
    const projectId = await seedProject("gts-twins", [shared, shared]);
    const testSetId = await makeSet(projectId, 6);

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    const rows = await activeQuestions(testSetId);
    expect(new Set(rows.map((r) => r.documentId)).size).toBe(2);
  });

  it("resumes onto passages the first attempt never reached", async () => {
    const text = longText("kappa");
    const projectId = await seedProject("gts-covered", [text]);
    const testSetId = await makeSet(projectId, 6);
    const [doc] = await ctx.db.select().from(documents).where(eq(documents.projectId, projectId));

    // The layout the handler will derive: one document, so the quota is the whole target.
    const passages = samplePassages(text, 6);
    expect(passages.length).toBeGreaterThanOrEqual(2);

    // A question already covering the first passage, as if a previous attempt had mined it.
    await ctx.db.insert(testQuestions).values({
      testSetId, documentId: doc.id, question: "seeded?", goldAnswer: text.slice(0, 40),
      goldStart: 0, goldEnd: 40,
    });

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    const generated = (await activeQuestions(testSetId)).filter((r) => r.question !== "seeded?");
    expect(generated.length).toBeGreaterThan(0);
    for (const row of generated) {
      expect(row.goldStart).toBeGreaterThanOrEqual(passages[1].start);
    }
  });

  it("marks the set failed when the provider fails in a way a retry cannot fix", async () => {
    const projectId = await seedProject("gts-authfail", [longText("lambda")]);
    const testSetId = await makeSet(projectId, 2, "claude-opus-5");

    // With no credentials the SDK rejects before any request goes out, which the provider layer
    // reports as a non-retryable ProviderError -- the class that must land on the set rather than
    // burn three pg-boss retries and leave it stuck in "generating".
    await withoutAnthropicCredentials(async () => {
      await expect(generateTestsetHandler(
        { testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss },
      )).resolves.toBeUndefined();
    });

    const set = await loadSet(testSetId);
    expect(set.status).toBe("failed");
    expect(set.error).toBeTruthy(); // the provider's own message, not asserted verbatim
    expect(await activeQuestions(testSetId)).toHaveLength(0);
  });

  it("marks a set that kept nothing ready, with the drop reasons on the row", async () => {
    // Sentences long enough for the demo generator (30+ chars) but almost entirely whitespace, so
    // every quote it proposes normalizes below verifyQuote's 12-char floor and is dropped. The run
    // is a complete, non-retryable one that produced no ground truth: it must not sit in
    // "generating", and it must not go ready with nothing to explain the empty set.
    const sentence = `Ab${" ".repeat(40)}cd.`;
    const projectId = await seedProject("gts-nokeep", [Array(40).fill(sentence).join(" ")]);
    const testSetId = await makeSet(projectId, 6);

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    const set = await loadSet(testSetId);
    expect(set.status).toBe("ready");
    expect(await activeQuestions(testSetId)).toHaveLength(0);
    expect(set.error).toContain("generated 0 of 6");
    expect(set.error).toMatch(/\d+ quotes? failed verification/);
  });

  it("does not resurrect a question the reviewer deleted", async () => {
    const projectId = await seedProject("gts-deleted", [longText("mu"), longText("nu")]);
    const testSetId = await makeSet(projectId, 6);

    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });
    const generated = await activeQuestions(testSetId);
    expect(generated.length).toBeGreaterThan(0);

    // Review rejects every question, and the set is re-run (a deletion drops the active count back
    // below target, so the resume has room to generate again). The demo generator is deterministic,
    // so the re-walk proposes exactly the rejected questions -- which must stay rejected.
    await ctx.db.update(testQuestions).set({ status: "deleted" })
      .where(eq(testQuestions.testSetId, testSetId));
    await ctx.db.update(testSets).set({ status: "generating" }).where(eq(testSets.id, testSetId));
    await generateTestsetHandler({ testSetId, organizationId: orgId }, { db: ctx.db, boss: noopBoss });

    const rejected = new Set(generated.map((r) => `${r.documentId}:${r.question}`));
    const after = await activeQuestions(testSetId);
    expect(after.filter((r) => rejected.has(`${r.documentId}:${r.question}`))).toHaveLength(0);
    expect((await loadSet(testSetId)).status).toBe("ready");
  });

  it("resolves without throwing when the test set is gone", async () => {
    await expect(generateTestsetHandler(
      { testSetId: "00000000-0000-0000-0000-000000000000", organizationId: orgId },
      { db: ctx.db, boss: noopBoss },
    )).resolves.toBeUndefined();
  });
});
