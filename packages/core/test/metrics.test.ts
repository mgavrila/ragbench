import { describe, it, expect } from "vitest";
import { spansOverlap, evaluateRetrieval, type Span } from "../src/metrics";

describe("spansOverlap", () => {
  const cases: Array<{ name: string; a: Span; b: Span; expected: boolean }> = [
    { name: "identical spans", a: { start: 0, end: 5 }, b: { start: 0, end: 5 }, expected: true },
    { name: "a contains b", a: { start: 0, end: 10 }, b: { start: 2, end: 5 }, expected: true },
    { name: "b contains a", a: { start: 2, end: 5 }, b: { start: 0, end: 10 }, expected: true },
    { name: "partial overlap, a first", a: { start: 0, end: 5 }, b: { start: 3, end: 8 }, expected: true },
    { name: "partial overlap, b first", a: { start: 3, end: 8 }, b: { start: 0, end: 5 }, expected: true },
    {
      name: "touching spans (half-open) do not overlap, a before b",
      a: { start: 0, end: 5 },
      b: { start: 5, end: 10 },
      expected: false,
    },
    {
      name: "touching spans (half-open) do not overlap, b before a",
      a: { start: 5, end: 10 },
      b: { start: 0, end: 5 },
      expected: false,
    },
    { name: "disjoint, a before b", a: { start: 0, end: 5 }, b: { start: 6, end: 10 }, expected: false },
    { name: "disjoint, b before a", a: { start: 6, end: 10 }, b: { start: 0, end: 5 }, expected: false },
    {
      name: "zero-length span never overlaps anything, even itself",
      a: { start: 3, end: 3 },
      b: { start: 3, end: 3 },
      expected: false,
    },
  ];

  for (const { name, a, b, expected } of cases) {
    it(name, () => {
      expect(spansOverlap(a, b)).toBe(expected);
    });
  }
});

describe("evaluateRetrieval", () => {
  const gold = { documentId: "doc-1", span: { start: 10, end: 20 } };

  it("hits at index 0 with reciprocal rank 1", () => {
    const retrieved = [
      { documentId: "doc-1", span: { start: 12, end: 18 } },
      { documentId: "doc-1", span: { start: 10, end: 20 } },
    ];
    expect(evaluateRetrieval(retrieved, gold)).toEqual({ hit: true, reciprocalRank: 1 });
  });

  it("hits at a later index with the matching reciprocal rank", () => {
    const retrieved = [
      { documentId: "doc-2", span: { start: 10, end: 20 } }, // wrong doc, same span
      { documentId: "doc-1", span: { start: 0, end: 5 } }, // right doc, no overlap
      { documentId: "doc-1", span: { start: 15, end: 25 } }, // match: right doc, overlapping span
    ];
    expect(evaluateRetrieval(retrieved, gold)).toEqual({ hit: true, reciprocalRank: 1 / 3 });
  });

  it("cross-doc match on the same span is not a hit", () => {
    const retrieved = [{ documentId: "doc-2", span: { start: 10, end: 20 } }];
    expect(evaluateRetrieval(retrieved, gold)).toEqual({ hit: false, reciprocalRank: 0 });
  });

  it("same-doc match with a touching (non-overlapping) span is not a hit", () => {
    const retrieved = [{ documentId: "doc-1", span: { start: 20, end: 30 } }];
    expect(evaluateRetrieval(retrieved, gold)).toEqual({ hit: false, reciprocalRank: 0 });
  });

  it("returns hit: false, reciprocalRank: 0 for an empty retrieved list", () => {
    expect(evaluateRetrieval([], gold)).toEqual({ hit: false, reciprocalRank: 0 });
  });

  it("no hit when nothing in the list matches doc and span together", () => {
    const retrieved = [
      { documentId: "doc-2", span: { start: 10, end: 20 } },
      { documentId: "doc-1", span: { start: 0, end: 5 } },
    ];
    expect(evaluateRetrieval(retrieved, gold)).toEqual({ hit: false, reciprocalRank: 0 });
  });
});
