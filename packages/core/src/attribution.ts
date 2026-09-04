/**
 * Deterministic attribution verdict engine (spec §7.3). Diagnoses WHY a run failed a question by
 * running an ordered, pure decision table over measured evidence: the gold span's shape relative to
 * chunk boundaries, its best rank in the full retrieval ordering, and a matrix of counterfactual
 * reruns (alternate chunker / embedder / top-k). The LLM never decides the verdict; it only explains
 * one after the fact (see buildExplanationPrompt/mockExplanation below).
 */

export type AttributionSignals = {
  /**
   * Whether the gold answer span lies entirely within a single chunk (vs. split across a boundary).
   * Invariant: goldInSingleChunk implies bestGoldRank !== null -- a chunk that contains the whole
   * span also overlaps it, so it appears (at some rank) in the full ordering below. This holds for a
   * fully embedded chunk set; a partially embedded one can break it (the containing chunk exists but
   * has no vector, so nothing ranks it), which decideVerdict tolerates rather than assumes away.
   */
  goldInSingleChunk: boolean;
  /**
   * 1-based rank of the best gold-overlapping chunk in the FULL retrieval ordering (not capped to k).
   * null means no chunk in the set overlaps the gold span at all (which also means goldInSingleChunk
   * must be false -- see the invariant above).
   */
  bestGoldRank: number | null;
  /** The top-k cutoff actually used by the run being diagnosed. */
  k: number;
};

export type Counterfactual = {
  kind: "chunker" | "embedder" | "topk";
  /** Human-readable label for the alternate config tried, e.g. "recursive, 512 tokens" or "k=10". */
  label: string;
  /** Whether this counterfactual config retrieved a gold-overlapping chunk within its cutoff. */
  hit: boolean;
  /** 1-based rank the gold-overlapping chunk landed at under this counterfactual, or null if none. */
  rank: number | null;
};

export type AttributionVerdict = "chunking" | "embedding" | "retrieval" | "unanswerable";

export type VerdictResult = { verdict: AttributionVerdict; rule: string };

function anyHit(counterfactuals: Counterfactual[], kind: Counterfactual["kind"]): boolean {
  return counterfactuals.some((c) => c.kind === kind && c.hit);
}

/**
 * Ordered decision table per spec §7.3. Rules are checked in order and the first match wins;
 * precedence is the product logic, not an implementation detail. `rule` names the matched rule for
 * auditability (stable identifiers: displayed in the UI and pinned by tests, do not rename lightly).
 *
 * Precondition: intended to be called only on a run that already missed gold within k (i.e.
 * bestGoldRank is null or > k). See the "rule 4 fallback" note below for what happens otherwise.
 *
 * AMENDMENT (post round-1 review): the original rule 2 fired on bare `!goldInSingleChunk`, and rule 3
 * included a `bestGoldRank === null` arm. Those two together made rule 4 (`unanswerable`) provably
 * unreachable -- rule 3's null arm always intercepted the exact case rule 4 exists to catch -- which
 * contradicts spec §7.3's explicit "no config combination hits" -> unanswerable row. Fixed below:
 * rule 2's straddle arm now additionally requires bestGoldRank !== null (a genuine straddle has a
 * chunk that *partially* overlaps gold, so it does appear in the ordering; bestGoldRank === null means
 * no chunk overlaps at all, which is chunk-boundary-agnostic and is not chunking evidence on its own).
 * Rule 3's null arm is deleted as dead code: goldInSingleChunk implies bestGoldRank !== null (see the
 * invariant on AttributionSignals), so that arm could never actually be null in a valid input; only
 * the `> k` arm was ever reachable there. Rule 4 is now the true fallback: bestGoldRank null (gold not
 * covered by any chunk) and no counterfactual, of any kind, recovers it.
 */
export function decideVerdict(signals: AttributionSignals, counterfactuals: Counterfactual[]): VerdictResult {
  const { goldInSingleChunk, bestGoldRank, k } = signals;

  // Rule 1 (§7.3 row 3, "Gold chunk ranked just outside K; raising K hits"): a near-miss fixable by
  // raising k is a retrieval-depth failure. Checked first so it outranks rule 2 even when the gold
  // span also straddles a chunk boundary (a near-miss you could fix by raising k is still a retrieval
  // failure, not a chunking one).
  if (bestGoldRank !== null && bestGoldRank > k && anyHit(counterfactuals, "topk")) {
    return { verdict: "retrieval", rule: "topk-recovers" };
  }

  // Rule 2 (§7.3 row 1, "Gold span split across boundary in S, and/or another chunker hits with same
  // E"): a genuine straddle -- some chunk partially overlaps gold (bestGoldRank !== null) but none
  // contains it whole -- is decisive chunking evidence (2a). A chunker counterfactual recovering gold
  // is independent evidence of the same failure mode (2b), and applies even when bestGoldRank is null
  // (gold isn't covered by any chunk in THIS set, but a different chunker's set does cover it). 2a is
  // checked first, so a straddling span is reported as "gold-straddles-chunks" even when a chunker
  // counterfactual also happens to hit.
  if (!goldInSingleChunk && bestGoldRank !== null) {
    return { verdict: "chunking", rule: "gold-straddles-chunks" };
  }
  if (anyHit(counterfactuals, "chunker")) {
    return { verdict: "chunking", rule: "chunker-counterfactual-hits" };
  }

  // Rule 3 (§7.3 row 2, "Gold span intact in one chunk; another embedder hits with same S; rank far
  // under E"): only applies when the gold chunk exists whole (goldInSingleChunk). The type's
  // invariant says bestGoldRank is then non-null, but the explicit null check in 3b below is NOT
  // redundant: the invariant is only as good as the caller's chunk set is complete. A partially
  // embedded set (an embed job that failed midway) can present goldInSingleChunk true with
  // bestGoldRank null, because the containing chunk exists but has no vector to be ranked by. This
  // function stays total on that input rather than trusting the invariant -- 3b simply does not
  // fire, and the input falls through to rule 4. An embedder counterfactual hit (3a) is checked
  // before the original-rank check (3b), so it wins the rule name when both hold.
  if (goldInSingleChunk) {
    if (anyHit(counterfactuals, "embedder")) {
      return { verdict: "embedding", rule: "embedder-counterfactual-hits" };
    }
    if (bestGoldRank !== null && bestGoldRank > k) {
      return { verdict: "embedding", rule: "gold-intact-not-ranked" };
    }
  }

  // Rule 4 (§7.3 row 4, "No config combination hits"): the gold span isn't captured by any chunk in
  // this set (bestGoldRank null, so it can't be a straddle either) and no tried combination -- real or
  // counterfactual, of any kind -- finds it anywhere. Likely a test-set data issue, not a pipeline bug.
  return { verdict: "unanswerable", rule: "nothing-hits" };
}

/**
 * Prompt asking an LLM to write a 2-3 sentence human explanation of a verdict already computed by
 * decideVerdict, strictly grounded in the evidence given: the LLM explains, it never diagnoses (§7.4).
 */
export function buildExplanationPrompt(
  question: string,
  verdict: AttributionVerdict,
  signals: AttributionSignals,
  counterfactuals: Counterfactual[],
): string {
  const matrix =
    counterfactuals.length === 0
      ? ["(no counterfactuals were run)"]
      : counterfactuals.map(
          (c) => `[${c.kind}] ${c.label}: ${c.hit ? "hit" : "miss"}${c.rank !== null ? ` at rank ${c.rank}` : ""}`,
        );

  return [
    `A retrieval-augmented QA pipeline failed to answer a question correctly. Automated analysis has`,
    `already determined the failure category below from measured evidence alone -- do not re-derive`,
    `or second-guess it. Write a 2-3 sentence explanation of why this verdict fits, using ONLY the`,
    `evidence given below. Do not invent numbers, ranks, or causes that are not present in the`,
    `evidence.`,
    ``,
    `Question: ${question}`,
    ``,
    `Verdict: ${verdict}`,
    ``,
    `Signals: gold span intact in a single chunk = ${signals.goldInSingleChunk}; best rank of a`,
    `gold-overlapping chunk (1-based, full ordering, null = none exists) = ${signals.bestGoldRank ?? "null"};`,
    `k = ${signals.k}.`,
    ``,
    `Counterfactual matrix:`,
    ...matrix,
    ``,
    `Explanation:`,
  ].join("\n");
}

/**
 * Deterministic demo-mode explanation: no LLM call, no randomness. One fixed template per verdict,
 * filled in with the signals that are relevant to that verdict.
 */
export function mockExplanation(verdict: AttributionVerdict, signals: AttributionSignals): string {
  const { goldInSingleChunk, bestGoldRank, k } = signals;
  switch (verdict) {
    case "retrieval":
      return (
        `The gold-overlapping chunk ranked ${bestGoldRank} against a top-${k} cutoff, just outside ` +
        `the retrieved set; a counterfactual run with a larger k retrieved it, so this is a ` +
        `retrieval-depth failure.`
      );
    case "chunking":
      // Mirrors decideVerdict's rule 2a/2b split: a genuine straddle (some chunk partially overlaps
      // gold, none contains it whole) is a different failure shape than a chunker counterfactual
      // recovering gold that this set's chunks -- intact or not covering it at all -- never surfaced.
      // Claiming a "boundary split" on the 2b door would be false when the gold span isn't split at
      // all; it just isn't in a retrievable chunk under this particular chunker's cuts.
      //
      // The 2b wording therefore states only what holds behind BOTH of its doors -- gold sitting
      // intact in a chunk that was not retrieved, and gold covered by no chunk in this set at all.
      // "No retrieved chunk covered the gold answer" is true either way; anything about how the
      // gold span itself is shaped would be a guess about which door was taken.
      return !goldInSingleChunk && bestGoldRank !== null
        ? `The gold answer span is split across a chunk boundary rather than living intact in one ` +
            `chunk, so no single retrieved chunk could ever contain the whole answer; this is a ` +
            `chunking failure.`
        : `Under this chunk set's cuts, no retrieved chunk covered the gold answer, but a ` +
            `different chunker's set retrieved it; the failure is in how the corpus was divided ` +
            `into chunks, not in the embedder or the cutoff.`;
    case "embedding":
      return bestGoldRank === null
        ? `The gold span sits intact in a single chunk, but that chunk was never ranked highly ` +
            `enough to appear in the ordering under the original embedder; this is an ` +
            `embedding/ranking failure.`
        : `The gold span sits intact in a single chunk, but it ranked ${bestGoldRank} against a ` +
            `top-${k} cutoff under the original embedder, well outside where it needed to land; ` +
            `this is an embedding/ranking failure.`;
    case "unanswerable":
      return (
        `No configuration -- original or counterfactual -- retrieved a chunk overlapping the gold ` +
        `span, so this question cannot be answered from the corpus as configured; it is flagged as ` +
        `a likely test-set issue.`
      );
  }
}
