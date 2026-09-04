import type { AttributionSignals, AttributionVerdict, Counterfactual } from "@ragbench/core";

/**
 * Mirrors `StoredCounterfactuals` from apps/worker/src/handlers/attribute.ts, which is what actually
 * lands in `attributions.counterfactuals` (jsonb). apps/web cannot import from apps/worker, so this
 * is a deliberate, pinned-by-contract redeclaration (see task-2-report.md's "Contracts for Task 3") --
 * keep it in sync with the worker type if that shape ever changes.
 */
export type StoredCounterfactuals = {
  matrix: Counterfactual[];
  /** Human-readable `<what>: <why>` lines for counterfactuals that could not be run. */
  skipped: string[];
  /** Stable rule id from decideVerdict (packages/core/src/attribution.ts), e.g. "gold-straddles-chunks". */
  rule: string;
  signals: AttributionSignals;
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
