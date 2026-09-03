import { and, eq, isNotNull } from "drizzle-orm";
import { documents, makeUsageReporter, testQuestions, testSets } from "@ragbench/db";
import {
  CHEAP_LLM, buildGenerationPrompt, buildTrivialityGatePrompt, lookupLlmModel, makeLLM,
  mockGenerateQa, normalizeWs, parseGateJson, parseQaJson, samplePassages, verifyQuote,
  type LLMProvider,
} from "@ragbench/core";
import type { JobHandler } from "../queue";

const GENERATION_MAX_TOKENS = 800;
// The gate answers with a single {"trivial": bool} object; anything longer is the model rambling,
// and parseGateJson fails open on truncated output anyway.
const GATE_MAX_TOKENS = 64;

type Passage = { text: string; start: number; end: number };
type Doc = { id: string; text: string };

/**
 * Interleaves each document's passages so consecutive questions come from different documents.
 * Generation stops as soon as the target is met, so without the interleave a short target would be
 * filled entirely from the first document and the test set would only ever probe one part of the
 * corpus. The per-document quota is the ceiling of an even split: a document with fewer passages
 * than its quota (short documents are a single passage) simply contributes fewer, and the set ends
 * up below target rather than over-sampling its neighbours.
 *
 * `target` is the set's full question target rather than the outstanding remainder, so a retry
 * derives the same layout in the same order and revisits the passages it already covered -- which
 * is what makes the caller's already-asked check able to recognise them.
 */
function roundRobinPassages(docs: Doc[], target: number): Array<{ doc: Doc; passage: Passage }> {
  const quota = Math.ceil(target / docs.length);
  const perDoc = docs.map((doc) => ({ doc, passages: samplePassages(doc.text, quota) }));
  const out: Array<{ doc: Doc; passage: Passage }> = [];
  const deepest = perDoc.reduce((n, d) => Math.max(n, d.passages.length), 0);
  for (let i = 0; i < deepest; i++) {
    for (const { doc, passages } of perDoc) {
      if (i < passages.length) out.push({ doc, passage: passages[i] });
    }
  }
  return out;
}

export const generateTestsetHandler: JobHandler<{ testSetId: string; organizationId: string }> =
  async ({ testSetId, organizationId }, { db }) => {
    const [set] = await db.select().from(testSets).where(eq(testSets.id, testSetId));
    if (!set) return; // deleted meanwhile -- idempotent no-op
    // The one guard that makes a re-delivered job free: a finished set is never regenerated.
    if (set.status === "ready") return;

    // Terminal, set-level failures (mirroring parse.ts's failure attribution): nothing to generate
    // from, and no retry can change that, so mark the set failed and return instead of throwing.
    // An unknown model is caught before any work: the API validates it at creation time, so this
    // only fires for a hand-written row, which would otherwise sit in "generating" forever.
    const modelEntry = lookupLlmModel(set.generatorModel);
    if (!modelEntry) {
      await db.update(testSets)
        .set({ status: "failed", error: `unknown generator model: ${set.generatorModel}` })
        .where(eq(testSets.id, testSetId));
      return;
    }

    const rows = await db.select().from(documents).where(and(
      eq(documents.projectId, set.projectId),
      eq(documents.status, "ready"),
      isNotNull(documents.text),
    ));
    // isNotNull is a SQL-level filter drizzle cannot reflect in the row type; re-assert it in TS.
    const docs: Doc[] = rows.flatMap((d) => (d.text === null ? [] : [{ id: d.id, text: d.text }]));
    if (docs.length === 0) {
      await db.update(testSets)
        .set({ status: "failed", error: "no ready documents" })
        .where(eq(testSets.id, testSetId));
      return;
    }

    // Resume: a retry after a crash mid-generation counts what already landed towards the target
    // and generates only the remainder, so questions never pile past `questionsTarget`. Questions
    // deleted during review are excluded, which lets the count reflect what the user actually kept.
    const existing = await db.select({ question: testQuestions.question }).from(testQuestions)
      .where(and(eq(testQuestions.testSetId, testSetId), eq(testQuestions.status, "active")));
    const wanted = set.questionsTarget - existing.length;

    if (wanted > 0) {
      // Questions already asked. A resume re-walks passages it has covered, and without this it
      // would store the same question twice; it also rejects one question arising from two
      // documents that share a sentence, since identical questions with different gold spans are
      // ambiguous ground truth the evaluator cannot score.
      const asked = new Set(existing.map((q) => normalizeWs(q.question)));
      const isMock = modelEntry.provider === "mock";
      const reporter = makeUsageReporter(db, organizationId);
      // Demo mode is a pure function over the passage: no provider, no key, no spend -- which is
      // also why the triviality gate (a second, billed call per candidate) is skipped for it.
      const generator: LLMProvider | null = isMock ? null : makeLLM(set.generatorModel, reporter, "testset");
      const gate: LLMProvider | null = isMock ? null : makeLLM(CHEAP_LLM, reporter, "testset-gate");

      let kept = 0;
      for (const { doc, passage } of roundRobinPassages(docs, set.questionsTarget)) {
        if (kept >= wanted) break;

        // ProviderErrors from here on are deliberately not caught: a retryable one (rate limit,
        // transient) must reach pg-boss so the job is retried and resumes from what was inserted.
        const candidates = generator
          ? parseQaJson(await generator.complete({
              prompt: buildGenerationPrompt(passage.text, 1), maxTokens: GENERATION_MAX_TOKENS,
            }))
          : mockGenerateQa(passage, 1);

        for (const candidate of candidates) {
          if (kept >= wanted) break;
          // Ground truth is extractive by construction: a quote the generator invented or
          // paraphrased has no span in the document and the question is dropped rather than
          // stored with a made-up answer. The span is resolved against the whole document (not
          // the passage) because that is the coordinate system the evaluator scores against.
          const span = verifyQuote(doc.text, candidate.quote);
          if (!span) continue;
          const key = normalizeWs(candidate.question);
          if (asked.has(key)) continue;

          if (gate) {
            const verdict = parseGateJson(await gate.complete({
              prompt: buildTrivialityGatePrompt(candidate.question, candidate.quote),
              maxTokens: GATE_MAX_TOKENS,
            }));
            // Fails open: an unparseable verdict keeps the question, since a gate outage should
            // cost the user a few weak questions, not the whole test set.
            if (verdict === true) continue;
          }

          // Inserted one at a time, as they are verified: this is what a retry resumes from.
          await db.insert(testQuestions).values({
            testSetId, documentId: doc.id, question: candidate.question,
            goldAnswer: candidate.answer, goldStart: span.start, goldEnd: span.end,
          });
          asked.add(key);
          kept++;
        }
      }
    }

    // Ready even when short of the target -- passages or verifiable quotes can simply run out, and
    // the UI reports the actual count. A DB failure here is NOT caught: it is transient, so the job
    // retries and the resume path above re-counts and finishes the set rather than marking it
    // failed over a blip.
    await db.update(testSets).set({ status: "ready", error: null }).where(eq(testSets.id, testSetId));
  };
