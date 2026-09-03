import { and, eq, isNotNull } from "drizzle-orm";
import { documents, makeUsageReporter, testQuestions, testSets } from "@ragbench/db";
import {
  CHEAP_LLM, ProviderError, buildGenerationPrompt, buildTrivialityGatePrompt, lookupLlmModel,
  makeLLM, mockGenerateQa, normalizeWs, parseGateJson, parseQaJson, samplePassages, verifyQuote,
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
 * Why each candidate the generator produced did not become a question. Every drop is silent on its
 * own -- a set that comes back with three questions out of thirty looks the same as one that came
 * back short because the corpus ran out of passages -- so they are counted and reported.
 */
type DropCounts = {
  verificationFailed: number;
  answerNotInQuote: number;
  gateTrivial: number;
  parseEmpty: number;
};

/** Human-readable account of a generation run, for the worker log and (when nothing was kept) the set's `error`. */
export function describeGeneration(kept: number, wanted: number, drops: DropCounts): string {
  const reasons = [
    [drops.verificationFailed, "quote failed verification", "quotes failed verification"],
    [drops.answerNotInQuote, "answer was not inside its quote", "answers were not inside their quote"],
    [drops.gateTrivial, "question was dropped as trivial", "questions were dropped as trivial"],
    [drops.parseEmpty, "passage produced no candidates", "passages produced no candidates"],
  ] as const;
  const parts = reasons
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return `generated ${kept} of ${wanted}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

/** Whitespace-token stand-in for a real tokenizer, matching what the mock provider reports. */
function estimateTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** A question is the same question only within the same document: two documents that share a
 * sentence should each get their own question and their own gold span. */
function questionKey(documentId: string, question: string): string {
  return `${documentId}:${normalizeWs(question)}`;
}

/**
 * Asks the cheap model whether a question is trivially string-matchable, and answers "keep it"
 * unless it says so clearly. Every uncertain outcome fails open, including the gate provider
 * failing outright: the gate runs on a *different* model than the generator, so treating its
 * outage as a set-level failure would sink a generation run that is otherwise working. Losing the
 * gate costs a few weak questions the user can delete in review, which is far cheaper than losing
 * the set. Only a non-provider failure (a bug in here) propagates.
 */
export async function passesTrivialityGate(
  gate: LLMProvider,
  question: string,
  quote: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await gate.complete({
      prompt: buildTrivialityGatePrompt(question, quote),
      maxTokens: GATE_MAX_TOKENS,
    });
  } catch (err) {
    if (err instanceof ProviderError) return true;
    throw err;
  }
  return parseGateJson(raw) !== true;
}

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
export function roundRobinPassages(docs: Doc[], target: number): Array<{ doc: Doc; passage: Passage }> {
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

    // Ordered because the passage layout is positional: a retry must see the documents in the same
    // order it did the first time, or the round-robin below shifts and the resume bookkeeping
    // (which passages are already covered) no longer lines up with what was generated.
    const rows = await db.select().from(documents).where(and(
      eq(documents.projectId, set.projectId),
      eq(documents.status, "ready"),
      isNotNull(documents.text),
    )).orderBy(documents.createdAt, documents.id);
    // isNotNull is a SQL-level filter drizzle cannot reflect in the row type; re-assert it in TS.
    const docs: Doc[] = rows.flatMap((d) => (d.text === null ? [] : [{ id: d.id, text: d.text }]));
    if (docs.length === 0) {
      await db.update(testSets)
        .set({ status: "failed", error: "no ready documents" })
        .where(eq(testSets.id, testSetId));
      return;
    }

    // Resume: a retry after a crash mid-generation counts what already landed towards the target
    // and generates only the remainder, so questions never pile past `questionsTarget`. Deleted
    // questions are read too but counted separately below: they do not fill the target (the count
    // reflects what the user actually kept) yet they still block their own regeneration.
    const stored = await db.select({
      documentId: testQuestions.documentId,
      question: testQuestions.question,
      goldStart: testQuestions.goldStart,
      status: testQuestions.status,
    }).from(testQuestions).where(eq(testQuestions.testSetId, testSetId));
    const existing = stored.filter((q) => q.status === "active");
    const wanted = set.questionsTarget - existing.length;
    // Non-null only when a run generated nothing: cleared on every other path so a set that
    // recovers on a retry does not keep an explanation for a shortfall it no longer has.
    let advisory: string | null = null;

    if (wanted > 0) {
      // Two pieces of resume bookkeeping, both derived from what is already stored.
      // `asked` stops a re-walked passage from storing the same question twice. `coveredStarts`
      // stops the re-walk from spending a generation call on that passage at all: a passage whose
      // range already contains a gold span has been mined, so the resume moves on to passages the
      // first attempt never reached. (A quote that also occurs earlier in the document resolves to
      // that earlier span, which can mark the wrong passage covered -- the cost is skipping one
      // passage, and the alternative is storing passage provenance we have no other use for.)
      // `asked` spans deleted questions too: a reviewer deleting a question is rejecting it, and a
      // resume that re-walks the passage must not put it back. Only the target count and the
      // covered-passage map read the active rows, since both describe what the set currently holds.
      const asked = new Set(stored.map((q) => questionKey(q.documentId, q.question)));
      const coveredStarts = new Map<string, number[]>();
      for (const q of existing) {
        coveredStarts.set(q.documentId, [...(coveredStarts.get(q.documentId) ?? []), q.goldStart]);
      }
      const isMock = modelEntry.provider === "mock";
      const reporter = makeUsageReporter(db, organizationId);

      let kept = 0;
      const drops: DropCounts = {
        verificationFailed: 0, answerNotInQuote: 0, gateTrivial: 0, parseEmpty: 0,
      };
      try {
        // Constructed inside the try so a provider SDK that throws from its constructor (a
        // malformed key, an unsupported option) is attributed to the set like any other
        // non-retryable provider failure, instead of escaping as an unhandled job error.
        // Demo mode is a pure function over the passage: no provider, no key, no spend -- which is
        // also why the triviality gate (a second, billed call per candidate) is skipped for it.
        const generator: LLMProvider | null = isMock ? null : makeLLM(set.generatorModel, reporter, "testset");
        const gate: LLMProvider | null = isMock ? null : makeLLM(CHEAP_LLM, reporter, "testset-gate");

        for (const { doc, passage } of roundRobinPassages(docs, set.questionsTarget)) {
          if (kept >= wanted) break;
          const covered = coveredStarts.get(doc.id)
            ?.some((start) => start >= passage.start && start < passage.end);
          if (covered) continue;

          const candidates = generator
            ? parseQaJson(await generator.complete({
                prompt: buildGenerationPrompt(passage.text, 1), maxTokens: GENERATION_MAX_TOKENS,
              }))
            : mockGenerateQa(passage, 1);
          if (candidates.length === 0) drops.parseEmpty++;
          // The demo generator spends nothing, but a demo run still has to show up in the usage
          // view -- an org that only ever ran demo sets would otherwise see an empty ledger and no
          // way to tell "nothing ran" from "nothing was recorded". Synthetic counts, zero cost.
          if (isMock) {
            await reporter({
              purpose: "testset", provider: modelEntry.provider, model: set.generatorModel,
              inputTokens: estimateTokens(passage.text),
              outputTokens: candidates.reduce(
                (n, c) => n + estimateTokens(`${c.question} ${c.answer} ${c.quote}`), 0,
              ),
            });
          }

          for (const candidate of candidates) {
            if (kept >= wanted) break;
            // Ground truth is extractive by construction: a quote the generator invented or
            // paraphrased has no span in the document and the question is dropped rather than
            // stored with a made-up answer. The span is resolved against the whole document (not
            // the passage) because that is the coordinate system the evaluator scores against.
            const span = verifyQuote(doc.text, candidate.quote);
            if (!span) { drops.verificationFailed++; continue; }
            // The span above only proves the QUOTE is in the document; the stored gold answer is
            // the model's `answer`, which the prompt requires to sit inside that quote. Without
            // this check a model that answers alongside its quote instead of from within it stores
            // an answer the span does not contain -- ground truth that contradicts its own offsets.
            if (!normalizeWs(candidate.quote).includes(normalizeWs(candidate.answer))) {
              drops.answerNotInQuote++;
              continue;
            }
            const key = questionKey(doc.id, candidate.question);
            if (asked.has(key)) continue;

            // Gate failures never reach the catch below: passesTrivialityGate owns them and keeps
            // the question, so only the generator call can fail or retry the set.
            if (gate && !(await passesTrivialityGate(gate, candidate.question, candidate.quote))) {
              drops.gateTrivial++;
              continue;
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
      } catch (err) {
        // Generator failures (the gate handles its own) split by whether another attempt could
        // plausibly succeed. A rate limit or a transient network fault is rethrown so pg-boss
        // retries and the resume path above picks up whatever was already inserted. An auth or
        // fatal error (missing key, model rejecting the request) cannot be retried into success,
        // so it is attributed to the set -- otherwise three silent retries end with the set stuck
        // in "generating" forever and no explanation in the UI. Questions already inserted are
        // verified ground truth and stay. Anything that is not a ProviderError (a DB fault, a bug
        // here) propagates untouched.
        if (err instanceof ProviderError && !err.retryable) {
          await db.update(testSets)
            .set({ status: "failed", error: err.message })
            .where(eq(testSets.id, testSetId));
          return;
        }
        throw err;
      }

      const summary = describeGeneration(kept, wanted, drops);
      console.log(`generate-testset ${testSetId}: ${summary}`);
      // A run that kept nothing is still a finished run, not a failure: the documents were read,
      // the generator answered, and every candidate was rejected for a reason worth surfacing. The
      // set goes ready (there is nothing to retry) with the reasons in `error`, which the UI shows
      // beside the status -- otherwise the user sees "ready, 0 questions" and no explanation.
      if (kept === 0) advisory = summary;
    }

    // Ready even when short of the target -- passages or verifiable quotes can simply run out, and
    // the UI reports the actual count. A DB failure here is NOT caught: it is transient, so the job
    // retries and the resume path above re-counts and finishes the set rather than marking it
    // failed over a blip.
    await db.update(testSets).set({ status: "ready", error: advisory }).where(eq(testSets.id, testSetId));
  };
