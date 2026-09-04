/**
 * Deterministic attribution verdict engine (spec §7.3). Diagnoses WHY a run failed a question by
 * running an ordered, pure decision table over measured evidence: the gold span's shape relative to
 * chunk boundaries, its best rank in the full retrieval ordering, and a matrix of counterfactual
 * reruns (alternate chunker / embedder / top-k). The LLM never decides the verdict; it only explains
 * one after the fact (see buildExplanationPrompt/mockExplanation below).
 */

export type AttributionSignals = {
  /** Whether the gold answer span lies entirely within a single chunk (vs. split across a boundary). */
  goldInSingleChunk: boolean;
  /**
   * 1-based rank of the best gold-overlapping chunk in the FULL retrieval ordering (not capped to k).
   * null means no chunk in the set overlaps the gold span at all.
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
  // E"): the gold span not being intact in any single chunk is itself decisive chunking evidence
  // (2a); a chunker counterfactual recovering it is independent evidence of the same failure mode
  // (2b). 2a is checked first, so a straddling span is reported as "gold-straddles-chunks" even when
  // a chunker counterfactual also happens to hit.
  if (!goldInSingleChunk) {
    return { verdict: "chunking", rule: "gold-straddles-chunks" };
  }
  if (anyHit(counterfactuals, "chunker")) {
    return { verdict: "chunking", rule: "chunker-counterfactual-hits" };
  }

  // Rule 3 (§7.3 row 2, "Gold span intact in one chunk; another embedder hits with same S; rank far
  // under E"): the gold chunk exists whole (goldInSingleChunk, guaranteed true past rule 2 above), so
  // any remaining miss is attributable to embedding/ranking, not chunking. An embedder counterfactual
  // hit (3a) is checked before the original-rank check (3b), so it wins the rule name when both hold.
  if (anyHit(counterfactuals, "embedder")) {
    return { verdict: "embedding", rule: "embedder-counterfactual-hits" };
  }
  if (bestGoldRank === null || bestGoldRank > k) {
    return { verdict: "embedding", rule: "gold-intact-not-ranked" };
  }

  // Rule 4 (§7.3 row 4, "No config combination hits"): nothing, real or counterfactual, recovers the
  // gold span anywhere -- likely a test-set data issue rather than a pipeline bug.
  //
  // NOTE (auditability): given rules 2-3 above, this branch is UNREACHABLE from any genuine failure
  // input. Rule 2 unconditionally claims every !goldInSingleChunk input as chunking, and rule 3
  // unconditionally claims every goldInSingleChunk input with bestGoldRank null or > k as embedding --
  // together those cover every case where the original run actually missed gold within k. The only
  // way to reach this fallback is to call decideVerdict on a non-failure (bestGoldRank !== null and
  // <= k, i.e. the original run actually hit), which violates this function's precondition. Kept as
  // the literal, spec-documented fallback (and exercised by a precondition-violation test) rather than
  // silently reshaped; flagged to the team as a decision table gap worth resolving (see
  // task-1-report.md).
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
  const { bestGoldRank, k } = signals;
  switch (verdict) {
    case "retrieval":
      return (
        `The gold-overlapping chunk ranked ${bestGoldRank} against a top-${k} cutoff, just outside ` +
        `the retrieved set; a counterfactual run with a larger k retrieved it, so this is a ` +
        `retrieval-depth failure.`
      );
    case "chunking":
      return (
        `The gold answer span is split across a chunk boundary rather than living intact in one ` +
        `chunk, so no single retrieved chunk could ever contain the whole answer; this is a ` +
        `chunking failure.`
      );
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
