import type { AttributionSignals, AttributionVerdict, Counterfactual } from "@ragbench/core";

/**
 * Mirrors `StoredSignals` from the worker: core's AttributionSignals plus the score of the best
 * gold-overlapping chunk, which decideVerdict does not consume and the evidence view renders.
 * Null exactly when bestGoldRank is null.
 */
export type StoredSignals = AttributionSignals & { bestGoldScore: number | null };

/**
 * Mirrors `StoredCounterfactuals` from apps/worker/src/handlers/attribute.ts, which is what actually
 * lands in `attributions.counterfactuals` (jsonb). apps/web cannot import from apps/worker, so this
 * is a deliberate, pinned-by-contract redeclaration -- keep it in sync with the worker type if that
 * shape ever changes.
 */
export type StoredCounterfactuals = {
  matrix: Counterfactual[];
  /** Human-readable `<what>: <why>` lines for counterfactuals that could not be run. */
  skipped: string[];
  /** Stable rule id from decideVerdict (packages/core/src/attribution.ts), e.g. "gold-straddles-chunks". */
  rule: string;
  signals: StoredSignals;
};

/** The `attributions` row shape as read back from Postgres, with `counterfactuals` cast to its real shape. */
export type Attribution = {
  id: string;
  resultId: string;
  verdict: AttributionVerdict;
  counterfactuals: StoredCounterfactuals;
  explanation: string | null;
  evidenceChunkIds: string[] | null;
};
