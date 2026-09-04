import { describe, it, expect } from "vitest";
import {
  decideVerdict,
  buildExplanationPrompt,
  mockExplanation,
  type AttributionSignals,
  type Counterfactual,
  type AttributionVerdict,
} from "../src/attribution";

function cf(kind: Counterfactual["kind"], hit: boolean, rank: number | null = null, label: string = kind): Counterfactual {
  return { kind, label, hit, rank };
}

describe("decideVerdict", () => {
  type Case = {
    name: string;
    signals: AttributionSignals;
    counterfactuals: Counterfactual[];
    verdict: AttributionVerdict;
    rule: string;
  };

  const cases: Case[] = [
    // --- Rule 1: retrieval (spec §7.3 row 3) ---
    {
      name: "rule 1: gold ranked just outside k, a topk counterfactual recovers it",
      signals: { goldInSingleChunk: true, bestGoldRank: 5, k: 3 },
      counterfactuals: [cf("topk", true, 5)],
      verdict: "retrieval",
      rule: "topk-recovers",
    },
    {
      name: "rule 1 does not fire when bestGoldRank is not past k, even with a topk hit",
      signals: { goldInSingleChunk: true, bestGoldRank: 3, k: 3 },
      counterfactuals: [cf("topk", true, 3)],
      // falls through rules 2/3 to the literal fallback: see "fallback" describe block below for why
      verdict: "unanswerable",
      rule: "nothing-hits",
    },
    {
      name: "rule 1 does not fire when bestGoldRank is null, even with a topk hit",
      signals: { goldInSingleChunk: false, bestGoldRank: null, k: 3 },
      counterfactuals: [cf("topk", true, 2)],
      verdict: "chunking",
      rule: "gold-straddles-chunks",
    },
    {
      name: "rule 1 does not fire without any topk counterfactual hit, even past k",
      signals: { goldInSingleChunk: true, bestGoldRank: 7, k: 3 },
      counterfactuals: [],
      verdict: "embedding",
      rule: "gold-intact-not-ranked",
    },
    {
      name: "collision: topk-hit + straddling chunks -> retrieval (rule 1 outranks rule 2)",
      signals: { goldInSingleChunk: false, bestGoldRank: 5, k: 3 },
      counterfactuals: [cf("topk", true, 5)],
      verdict: "retrieval",
      rule: "topk-recovers",
    },

    // --- Rule 2: chunking (spec §7.3 row 1) ---
    {
      name: "rule 2a: gold span straddles a chunk boundary",
      signals: { goldInSingleChunk: false, bestGoldRank: null, k: 3 },
      counterfactuals: [],
      verdict: "chunking",
      rule: "gold-straddles-chunks",
    },
    {
      name: "rule 2b: gold intact in one chunk, but a chunker counterfactual hits",
      signals: { goldInSingleChunk: true, bestGoldRank: null, k: 3 },
      counterfactuals: [cf("chunker", true, 2)],
      verdict: "chunking",
      rule: "chunker-counterfactual-hits",
    },
    {
      name: "collision: straddling + chunker-hit -> chunking via the straddle branch (2a checked before 2b)",
      signals: { goldInSingleChunk: false, bestGoldRank: null, k: 3 },
      counterfactuals: [cf("chunker", true, 2)],
      verdict: "chunking",
      rule: "gold-straddles-chunks",
    },
    {
      name: "rule 2 outranks rule 3: straddling chunks even with an embedder counterfactual hit",
      signals: { goldInSingleChunk: false, bestGoldRank: null, k: 3 },
      counterfactuals: [cf("embedder", true, 2)],
      verdict: "chunking",
      rule: "gold-straddles-chunks",
    },

    // --- Rule 3: embedding (spec §7.3 row 2) ---
    {
      name: "rule 3a: gold intact, an embedder counterfactual hits (collision: intact + embedder hit -> embedding)",
      signals: { goldInSingleChunk: true, bestGoldRank: null, k: 3 },
      counterfactuals: [cf("embedder", true, 2)],
      verdict: "embedding",
      rule: "embedder-counterfactual-hits",
    },
    {
      name: "rule 3b boundary: gold intact, bestGoldRank null, zero counterfactual hits anywhere -> embedding, not unanswerable (rule 3 fires before rule 4)",
      signals: { goldInSingleChunk: true, bestGoldRank: null, k: 3 },
      counterfactuals: [],
      verdict: "embedding",
      rule: "gold-intact-not-ranked",
    },
    {
      name: "rule 3b: gold intact, bestGoldRank past k, no embedder hit, no topk hit",
      signals: { goldInSingleChunk: true, bestGoldRank: 9, k: 3 },
      counterfactuals: [cf("chunker", false, null)],
      verdict: "embedding",
      rule: "gold-intact-not-ranked",
    },
    {
      name: "rule 3 embedder-hit branch is checked before the gold-intact-not-ranked branch",
      signals: { goldInSingleChunk: true, bestGoldRank: null, k: 3 },
      counterfactuals: [cf("embedder", true, 1), cf("chunker", false)],
      verdict: "embedding",
      rule: "embedder-counterfactual-hits",
    },
  ];

  for (const { name, signals, counterfactuals, verdict, rule } of cases) {
    it(name, () => {
      expect(decideVerdict(signals, counterfactuals)).toEqual({ verdict, rule });
    });
  }

  describe("rule 4 fallback (spec §7.3 row 4, 'nothing-hits')", () => {
    // decideVerdict is only meaningful when called on an already-failed run (the original config did
    // not hit gold within k). Given that precondition, rule 4 is UNREACHABLE: rule 2 unconditionally
    // claims every !goldInSingleChunk input as "chunking", and rule 3 unconditionally claims every
    // goldInSingleChunk input where bestGoldRank is null OR past k as "embedding" -- which together
    // cover every failing input. The literal fallback is only reachable by feeding decideVerdict a
    // NON-failure (bestGoldRank !== null && bestGoldRank <= k), which is a precondition violation, not
    // a genuine "nothing hits anywhere" case. Kept and tested here for completeness/auditability; see
    // task-1-report.md for the full analysis and a recommendation for the team to resolve.
    it("is reached (as a precondition-violation, not a genuine miss) when fed a non-failure input", () => {
      const signals: AttributionSignals = { goldInSingleChunk: true, bestGoldRank: 3, k: 3 };
      expect(decideVerdict(signals, [])).toEqual({ verdict: "unanswerable", rule: "nothing-hits" });
    });
  });
});

describe("buildExplanationPrompt", () => {
  it("contains the question, verdict, signals, and counterfactual matrix", () => {
    const signals: AttributionSignals = { goldInSingleChunk: true, bestGoldRank: 5, k: 3 };
    const counterfactuals: Counterfactual[] = [cf("topk", true, 5, "k=10")];
    const prompt = buildExplanationPrompt("What is X?", "retrieval", signals, counterfactuals);

    expect(prompt).toContain("What is X?");
    expect(prompt).toContain("retrieval");
    expect(prompt).toContain("true"); // goldInSingleChunk
    expect(prompt).toContain("5"); // bestGoldRank
    expect(prompt).toContain("3"); // k
    expect(prompt).toContain("k=10");
    expect(prompt).toContain("hit");
    expect(prompt.toLowerCase()).toContain("do not invent");
  });

  it("notes when there are no counterfactuals", () => {
    const signals: AttributionSignals = { goldInSingleChunk: false, bestGoldRank: null, k: 3 };
    const prompt = buildExplanationPrompt("What is X?", "chunking", signals, []);
    expect(prompt.toLowerCase()).toContain("no counterfactuals were run");
  });

  it("renders a null bestGoldRank readably", () => {
    const signals: AttributionSignals = { goldInSingleChunk: true, bestGoldRank: null, k: 3 };
    const prompt = buildExplanationPrompt("What is X?", "embedding", signals, []);
    expect(prompt).toContain("null");
  });
});

describe("mockExplanation", () => {
  it("is deterministic per verdict", () => {
    const signals: AttributionSignals = { goldInSingleChunk: true, bestGoldRank: 5, k: 3 };
    const a = mockExplanation("retrieval", signals);
    const b = mockExplanation("retrieval", signals);
    expect(a).toBe(b);
  });

  it("retrieval template mentions bestGoldRank and k", () => {
    const text = mockExplanation("retrieval", { goldInSingleChunk: true, bestGoldRank: 5, k: 3 });
    expect(text).toContain("5");
    expect(text).toContain("3");
  });

  it("chunking template does not depend on rank", () => {
    const text = mockExplanation("chunking", { goldInSingleChunk: false, bestGoldRank: null, k: 3 });
    expect(text.toLowerCase()).toContain("boundary");
  });

  it("embedding template handles a null bestGoldRank", () => {
    const text = mockExplanation("embedding", { goldInSingleChunk: true, bestGoldRank: null, k: 3 });
    expect(text.toLowerCase()).toContain("never ranked");
  });

  it("embedding template mentions bestGoldRank and k when rank is present", () => {
    const text = mockExplanation("embedding", { goldInSingleChunk: true, bestGoldRank: 9, k: 3 });
    expect(text).toContain("9");
    expect(text).toContain("3");
  });

  it("unanswerable template flags a test-set issue", () => {
    const text = mockExplanation("unanswerable", { goldInSingleChunk: false, bestGoldRank: null, k: 3 });
    expect(text.toLowerCase()).toContain("test-set");
  });
});
