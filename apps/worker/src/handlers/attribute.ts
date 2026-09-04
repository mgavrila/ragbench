import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import {
  attributions, chunkEmbeddings, chunkSets, chunks, evalRuns, makeUsageReporter, questionResults,
  ragConfigs, testQuestions, type Db,
} from "@ragbench/db";
import {
  ProviderError, buildExplanationPrompt, decideVerdict, evaluateRetrieval, lookupEmbeddingModel,
  makeEmbedder, makeLLM, mockExplanation,
  type AttributionSignals, type Counterfactual, type UsageReporter,
} from "@ragbench/core";
import type { PgBoss } from "pg-boss";
import { retrieveTopK, type RetrievedChunk } from "../retrieve";

/** Demo-mode model id. Routed to the deterministic pure functions instead of any provider call. */
const MOCK_LLM = "mock-llm";

/** Every provider call this job makes is metered under one purpose, so a diagnose is one line item. */
const PURPOSE = "attribution";

/** The explanation is 2-3 sentences (see buildExplanationPrompt); the cap is a runaway-cost guard. */
const EXPLANATION_MAX_TOKENS = 300;

/** Whitespace-token stand-in for a real tokenizer, matching what the mock providers report. */
function estimateTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

type Gold = { documentId: string; span: { start: number; end: number } };

/**
 * What lands in `attributions.counterfactuals`.
 *
 * SHAPE NOTE (deliberate superset of the plan's `{ matrix, skipped }` ruling): `matrix` and
 * `skipped` are exactly as ruled -- every (chunk set x model) pair that could not be run is OMITTED
 * from the matrix and named in `skipped` instead of being recorded with a null hit. `rule` and
 * `signals` ride along because the `attributions` table has no column for either and the UI has to
 * show both: the matched rule name is what makes a verdict auditable ("why did it say chunking?"),
 * and the signals are the numbers the explanation and the evidence view quote. Adding them here
 * costs one jsonb field and no migration; readers that only want the ruled shape can ignore them.
 */
export type StoredCounterfactuals = {
  matrix: Counterfactual[];
  /** Human-readable `<what>: <why>` lines for counterfactuals that were not run. */
  skipped: string[];
  /** The `rule` name decideVerdict matched (stable identifier, see packages/core/src/attribution.ts). */
  rule: string;
  signals: AttributionSignals;
};

type Evidence = {
  signals: AttributionSignals;
  matrix: Counterfactual[];
  skipped: string[];
  evidenceChunkIds: string[];
};

/**
 * Scores one retrieval ordering against the gold span and recovers the integer rank of the hit.
 * evaluateRetrieval reports reciprocal rank rather than rank, so 1/rr inverts it (rr is exactly
 * 1/(i+1) for the first overlapping row, so the round() is defensive against float noise only);
 * rr 0 means nothing in the ordering overlapped gold, which is a null rank, not rank 0.
 */
function scoreAgainstGold(retrieved: RetrievedChunk[], gold: Gold): { hit: boolean; rank: number | null } {
  const { hit, reciprocalRank } = evaluateRetrieval(
    retrieved.map((r) => ({ documentId: r.documentId, span: { start: r.startOffset, end: r.endOffset } })),
    gold,
  );
  return { hit, rank: reciprocalRank > 0 ? Math.round(1 / reciprocalRank) : null };
}

async function embedQuestion(
  factory: typeof makeEmbedder,
  model: string,
  question: string,
  report: UsageReporter,
): Promise<number[]> {
  const [vector] = await factory(model, report).embed([question]);
  // Same reasoning as evaluate-question.ts: an empty batch is a provider misbehaving, not an empty
  // result. The zero-LENGTH case is checked here as well as by retrieveTopK, and the duplication is
  // deliberate: retrieveTopK's own throw would be raised from OUTSIDE this function, past the
  // per-cell catch in the embedder loop, and would land in the handler's outer catch -- reporting an
  // alternate embedder's misbehaviour as a failure of the config's own query embed, which discards
  // the whole diagnosis. Classified here instead, so each model's failure stays attached to it.
  if (vector === undefined || vector.length === 0) {
    throw new ProviderError(
      "fatal",
      // Second field is the PROVIDER, not the model -- the registry maps one to the other.
      lookupEmbeddingModel(model)?.provider ?? "unknown",
      `embedder returned no usable vector for the question (${model})`,
    );
  }
  return vector;
}

/** `${chunker} (${first 8 of paramsHash})` -- enough to tell two configurations of one chunker apart. */
function chunkSetLabel(set: { chunker: string; paramsHash: string }): string {
  return `${set.chunker} (${set.paramsHash.slice(0, 8)})`;
}

/**
 * Runs the deterministic signals and the counterfactual matrix for one (result, config) pair.
 *
 * Everything here is measured over data that ALREADY EXISTS: no chunk set is built and no corpus is
 * embedded to fill a hole in the matrix. A diagnose must not silently spend what a run cost, so a
 * (chunk set x model) pair with no embeddings is reported in `skipped` and the cell is omitted
 * rather than being embedded on the spot (v1 ruling; the cost-surfaced version is v1.1).
 *
 * The only provider spend is query embeds: one for the config's own model, plus one per alternate
 * embedder that already has vectors on this chunk set.
 */
async function gatherEvidence(
  db: Db,
  opts: {
    config: typeof ragConfigs.$inferSelect;
    set: typeof chunkSets.$inferSelect;
    question: typeof testQuestions.$inferSelect;
    embedderFactory: typeof makeEmbedder;
    report: UsageReporter;
  },
): Promise<Evidence> {
  const { config, set, question, embedderFactory, report } = opts;
  const gold: Gold = {
    documentId: question.documentId,
    span: { start: question.goldStart, end: question.goldEnd },
  };
  const matrix: Counterfactual[] = [];
  const skipped: string[] = [];

  // ---- signal 1: is the gold span cut by a chunk boundary in THIS set? ----
  // Half-open overlap (start < goldEnd AND end > goldStart), the same predicate spansOverlap uses,
  // so a chunk that merely touches the span at an endpoint does not count. Containment is then a
  // filter over these rows rather than its own query: a chunk containing the whole span necessarily
  // overlaps it, so it is in the ordering below and AttributionSignals' invariant
  // (goldInSingleChunk => bestGoldRank !== null) holds.
  //
  // LIMIT OF THAT ARGUMENT: it holds for a FULLY embedded chunk set. These rows come from `chunks`,
  // while the ordering comes from a join against `chunk_embeddings`, so a set that is only partly
  // embedded (an embed job that failed midway leaves some chunks without vectors) can have a
  // containing chunk that is missing from the ordering -- goldInSingleChunk true alongside
  // bestGoldRank null. decideVerdict handles that shape without crashing (it falls through to
  // `unanswerable`, or to whatever a counterfactual recovers), so the failure mode is a misleading
  // verdict on a half-built set, not an exception. startRunHandler now refuses to start a run whose
  // config points at a partly embedded set, so a result reaching this job was produced against a
  // complete one; the counterfactual sections below apply the same completeness check to every
  // ALTERNATE set and model, and report the incomplete ones as skipped rather than ranking against
  // a fraction of a set. This job still embeds nothing to fill a hole.
  const overlapping = await db.select({
    id: chunks.id, startOffset: chunks.startOffset, endOffset: chunks.endOffset,
  })
    .from(chunks)
    .where(and(
      eq(chunks.chunkSetId, set.id),
      eq(chunks.documentId, question.documentId),
      lt(chunks.startOffset, question.goldEnd),
      gt(chunks.endOffset, question.goldStart),
    ))
    .orderBy(chunks.idx);
  const goldInSingleChunk = overlapping.some(
    (c) => c.startOffset <= question.goldStart && c.endOffset >= question.goldEnd,
  );

  // ---- signal 2: where does the best gold-overlapping chunk land in the FULL ordering? ----
  const queryEmbedding = await embedQuestion(
    embedderFactory, config.embeddingModel, question.question, report,
  );
  const [counted] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(chunks).where(eq(chunks.chunkSetId, set.id));
  const totalChunks = counted?.n ?? 0;
  // Ranking the whole set (not top-k) is the point: bestGoldRank has to be able to exceed k, which
  // is what tells "ranked just outside the cutoff" apart from "not ranked at all". A set with no
  // chunks is not asked for a k=0 retrieval -- retrieveTopK rejects k < 1 as a caller bug -- and has
  // no gold-overlapping chunk by definition, so its rank is null.
  const full = totalChunks === 0 ? [] : await retrieveTopK(db, {
    chunkSetId: set.id, model: config.embeddingModel, queryEmbedding, k: totalChunks,
  });
  const bestGoldRank = scoreAgainstGold(full, gold).rank;

  // ---- counterfactual: same embedder and k, a different chunker ----
  const otherSets = await db.select().from(chunkSets)
    .where(and(eq(chunkSets.projectId, set.projectId), ne(chunkSets.id, set.id)))
    // Oldest first, so the matrix reads in the order the user built their chunk sets and two runs
    // of the same diagnose produce the same table.
    .orderBy(chunkSets.createdAt, chunkSets.id);
  // Per-set chunk and vector counts rather than a bare "has at least one vector" probe: a set whose
  // embed job died halfway ranks only the fraction of its chunks that got vectors, and a chunker
  // counterfactual measured over a fraction of a set is not evidence about the chunker -- a miss
  // there could just be the missing half. Counting is safe over this left join because
  // chunk_embeddings is unique on (chunk_id, model), so the join cannot multiply a chunk's row.
  const setCoverage = new Map<string, { total: number; embedded: number }>(
    (otherSets.length === 0 ? [] : await db.select({
      id: chunks.chunkSetId,
      total: sql<number>`count(*)`.mapWith(Number),
      embedded: sql<number>`count(${chunkEmbeddings.chunkId})`.mapWith(Number),
    })
      .from(chunks)
      .leftJoin(chunkEmbeddings, and(
        eq(chunkEmbeddings.chunkId, chunks.id),
        eq(chunkEmbeddings.model, config.embeddingModel),
      ))
      .where(inArray(chunks.chunkSetId, otherSets.map((s) => s.id)))
      .groupBy(chunks.chunkSetId)).map((r) => [r.id, { total: r.total, embedded: r.embedded }]),
  );
  for (const other of otherSets) {
    const label = chunkSetLabel(other);
    const coverage = setCoverage.get(other.id);
    // No row at all means the set has no chunks yet, which is indistinguishable from unembedded
    // here: either way there is nothing of this set to rank.
    if (!coverage || coverage.embedded === 0) {
      skipped.push(`chunker "${label}": not embedded with ${config.embeddingModel}`);
      continue;
    }
    if (coverage.embedded < coverage.total) {
      skipped.push(
        `chunker "${label}": partially embedded (${coverage.embedded}/${coverage.total} chunks)`,
      );
      continue;
    }
    const rows = await retrieveTopK(db, {
      chunkSetId: other.id, model: config.embeddingModel, queryEmbedding, k: config.topK,
    });
    matrix.push({ kind: "chunker", label, ...scoreAgainstGold(rows, gold) });
  }

  // ---- counterfactual: same chunk set and k, a different embedder ----
  // Counted per model, not merely enumerated, for the same reason as the chunk sets above: a model
  // with vectors for some of this set's chunks ranks against a fraction of the set, which is not a
  // fair comparison with the config's own model.
  const modelCoverage = await db.select({
    model: chunkEmbeddings.model,
    embedded: sql<number>`count(*)`.mapWith(Number),
  })
    .from(chunkEmbeddings)
    .innerJoin(chunks, eq(chunkEmbeddings.chunkId, chunks.id))
    .where(eq(chunks.chunkSetId, set.id))
    .groupBy(chunkEmbeddings.model);
  const embeddedModels = modelCoverage.map((r) => r.model);
  const embeddedCount = new Map(modelCoverage.map((r) => [r.model, r.embedded]));
  // Sorted so the matrix order does not depend on which model happened to be embedded first.
  for (const model of embeddedModels.filter((m) => m !== config.embeddingModel).sort()) {
    // A model with vectors in the database but no registry entry (removed in a later release, say)
    // would make makeEmbedder throw a plain Error and burn every retry of this job on something no
    // retry can fix. It is missing evidence, so it is reported like any other missing cell. Checked
    // before the completeness check below: an unusable model is unusable at any coverage, and
    // naming the registry is the more actionable of the two messages.
    if (!lookupEmbeddingModel(model)) {
      skipped.push(`embedder "${model}": not a known embedding model`);
      continue;
    }
    const embedded = embeddedCount.get(model) ?? 0;
    if (embedded < totalChunks) {
      skipped.push(`embedder "${model}": partially embedded (${embedded}/${totalChunks} chunks)`);
      continue;
    }
    let vector: number[];
    try {
      // The question has to be embedded by THIS model to be comparable with its chunk vectors --
      // reusing the config's vector would compare two different vector spaces.
      vector = await embedQuestion(embedderFactory, model, question.question, report);
    } catch (err) {
      // Fail-open, one cell at a time: an alternate embedder the org has no key for is missing
      // evidence, not a failed diagnose -- the verdict never depends on a counterfactual being
      // runnable. (Contrast the config's OWN embed above, which is outside this try: without it
      // there are no signals at all, and the caller's policy applies.) A retryable failure still
      // propagates, so a rate limit retries the job instead of freezing a hole into the row.
      if (err instanceof ProviderError && !err.retryable) {
        skipped.push(`embedder "${model}": ${err.message}`);
        continue;
      }
      throw err;
    }
    const rows = await retrieveTopK(db, {
      chunkSetId: set.id, model, queryEmbedding: vector, k: config.topK,
    });
    matrix.push({ kind: "embedder", label: model, ...scoreAgainstGold(rows, gold) });
  }
  // Models this set was ASKED to embed that have no vectors yet -- an embed job still queued, or one
  // that failed (chunk_sets.embedError). The pair exists in intent but not in data, so the user is
  // told the cell is missing rather than being billed for the embedding run that would fill it.
  const embedded = new Set(embeddedModels);
  for (const model of [...new Set(set.embedModels)].sort()) {
    if (model === config.embeddingModel || embedded.has(model)) continue;
    skipped.push(`embedder "${model}": requested for this chunk set but not embedded yet`);
  }

  // ---- counterfactual: same chunk set and embedder, a deeper cutoff ----
  // Sliced out of the full ordering already in hand rather than re-queried: retrieveTopK with a
  // larger k returns exactly this prefix (same ordering, same id tie-break), so two more round
  // trips to Postgres would return rows we are already holding.
  let deepest = config.topK;
  // The label of the deepest cell a reader can actually SEE (the config's own k to start with, then
  // whichever topk cell last made it into the matrix). The skip message below names this rather than
  // `deepest`, which is a row count: in a 12-chunk set at topK 8 the k=16 cell exists and retrieves
  // 12 rows, so "same rows as k=16" points at something on screen where "same rows as k=12" would
  // name a cutoff that appears nowhere.
  let deepestLabel = `k=${config.topK}`;
  for (const multiple of [2, 4] as const) {
    const requested = config.topK * multiple;
    // Clamped to what is actually retrievable: asking for k=40 in a 16-chunk set is still a 16-chunk
    // retrieval. The label keeps the requested number, because that is the config a user would set.
    const effective = Math.min(requested, full.length);
    if (effective <= deepest) {
      skipped.push(
        `k=${requested}: only ${full.length} chunk(s) are retrievable here, so it retrieves the ` +
          `same rows as ${deepestLabel}`,
      );
      continue;
    }
    matrix.push({ kind: "topk", label: `k=${requested}`, ...scoreAgainstGold(full.slice(0, effective), gold) });
    deepest = effective;
    deepestLabel = `k=${requested}`;
  }

  // Gold-overlapping chunks first (what the evidence view highlights), then what the run actually
  // retrieved, deduped -- the two overlap whenever the run retrieved a gold chunk at all.
  const evidenceChunkIds = [...new Set([
    ...overlapping.map((c) => c.id),
    ...full.slice(0, config.topK).map((r) => r.chunkId),
  ])];

  return {
    signals: { goldInSingleChunk, bestGoldRank, k: config.topK },
    matrix,
    skipped,
    evidenceChunkIds,
  };
}

/**
 * Diagnoses ONE question result: why did this (config, question) pair fail?
 *
 * The verdict is decided by decideVerdict from measured evidence alone (spec §7.3) -- the LLM is
 * only ever asked to phrase an explanation of a verdict that has already been decided, and its
 * failure cannot change one. Works on any result row, hit or miss: the UI offers Diagnose on misses,
 * but a user is allowed to ask about a row that hit, and the decision table has an answer either way.
 *
 * `embedderFactory`/`llmFactory` default to the real provider factories and exist only so a test can
 * inject a stub that fails deterministically (same seam and reasoning as embedHandler and
 * evaluateQuestionHandler). Not annotated as JobHandler<T> (which fixes the call signature at
 * exactly two params) so tests can pass the extra arguments; the optional params still leave this
 * assignable wherever a JobHandler<T> is expected (see main.ts).
 */
export const attributeHandler = async (
  { resultId, organizationId }: { resultId: string; organizationId: string },
  { db }: { db: Db; boss: PgBoss },
  embedderFactory: typeof makeEmbedder = makeEmbedder,
  llmFactory: typeof makeLLM = makeLLM,
): Promise<void> => {
  // One attribution per result: a re-delivered job (pg-boss is at-least-once) must not pay for a
  // second matrix, and re-diagnosing cannot change a verdict computed from the same rows anyway.
  // This read is the CHEAP path -- it is what stops the second delivery spending on a second matrix
  // -- not the guarantee. Two deliveries can both read "no row yet" before either inserts, so the
  // insert at the end of this handler is guarded by the unique index on attributions.result_id.
  const [existing] = await db.select({ id: attributions.id })
    .from(attributions).where(eq(attributions.resultId, resultId));
  if (existing) return;

  const [result] = await db.select().from(questionResults).where(eq(questionResults.id, resultId));
  if (!result) return;
  const [question] = await db.select().from(testQuestions)
    .where(eq(testQuestions.id, result.questionId));
  const [config] = await db.select().from(ragConfigs).where(eq(ragConfigs.id, result.configId));
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, result.runId));
  if (!question || !config || !run) return;
  const [set] = await db.select().from(chunkSets).where(eq(chunkSets.id, config.chunkSetId));
  // A broken chain (a config whose chunk set was deleted, a result whose question is gone) is an
  // integrity problem no retry fixes, so the job no-ops rather than retrying itself to death.
  if (!set) return;

  const reporter = makeUsageReporter(db, organizationId);
  const report: UsageReporter = (usage) => reporter({ ...usage, purpose: PURPOSE });

  let evidence: Evidence;
  try {
    evidence = await gatherEvidence(db, { config, set, question, embedderFactory, report });
  } catch (err) {
    // The config's own query embed is the one call this job cannot do without: no vector, no
    // ranking, no signals, no verdict. RULING (plan 5): a non-retryable failure here writes NOTHING
    // and does NOT throw. There is no status column on `attributions` to record a failed diagnose,
    // and throwing would burn three pg-boss retries on a key that can never work and then vanish
    // into the dead-letter queue. Diagnose is user-paced and re-clickable, so the honest v1
    // behaviour is to log loudly and leave the result undiagnosed -- the UI keeps offering the
    // button. A retryable failure (rate limit, transient fault) and anything that is not a
    // ProviderError (a DB fault, a bug here) propagate untouched for pg-boss to retry.
    if (err instanceof ProviderError && !err.retryable) {
      console.error(`attribution embed failed for result ${resultId}: ${err.message}`);
      return;
    }
    throw err;
  }

  const { signals, matrix, skipped, evidenceChunkIds } = evidence;
  const { verdict, rule } = decideVerdict(signals, matrix);

  // The explanation is decoration on an already-decided verdict, so it is gate-style fail-open: a
  // provider failure of ANY class (retryable included -- retrying the whole job would re-run every
  // counterfactual retrieval to re-ask for prose) leaves `explanation` null and still stores the
  // verdict. Anything that is not a ProviderError is a bug and propagates.
  let explanation: string | null = null;
  // Null on a run that never pinned a judge model (a retrieval-only run may have none): the
  // deterministic half of the diagnosis stands on its own.
  const model = run.judgeModel;
  if (model) {
    const prompt = buildExplanationPrompt(question.question, verdict, signals, matrix);
    try {
      if (model === MOCK_LLM) {
        explanation = mockExplanation(verdict, signals);
        // Demo mode spends nothing but still has to appear in the usage ledger, or an org that only
        // ever ran demo diagnoses sees an empty view (mirrors reportMockUsage in evaluate-question).
        await report({
          provider: "mock", model: MOCK_LLM, purpose: PURPOSE,
          inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(explanation),
        });
      } else {
        explanation = await llmFactory(model, report, PURPOSE)
          .complete({ prompt, maxTokens: EXPLANATION_MAX_TOKENS });
      }
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      console.error(`attribution explanation failed for result ${resultId}: ${err.message}`);
      explanation = null;
    }
  }

  const counterfactuals: StoredCounterfactuals = { matrix, skipped, rule, signals };
  // The loser of a race between two concurrent diagnoses of one result writes nothing rather than
  // failing the job: both computed a verdict from the same rows, so the row already there is the
  // same answer this one would have written (see the unique index on attributions.result_id).
  await db.insert(attributions)
    .values({ resultId, verdict, counterfactuals, explanation, evidenceChunkIds })
    .onConflictDoNothing();
};
