import { describe, it, expect } from "vitest";
import { chunkFixed, chunkHeading, chunkSentenceWindow, CHUNKERS, hashParams, type Chunk } from "../src/chunkers";

function assertInvariants(input: string, out: Chunk[]) {
  for (const c of out) {
    expect(c.text.length).toBeGreaterThan(0);
    expect(input.slice(c.startOffset, c.endOffset)).toBe(c.text);
  }
  for (let i = 1; i < out.length; i++) expect(out[i].startOffset).toBeGreaterThanOrEqual(out[i - 1].startOffset);
}

const WORDS = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
const MD = "# Title\nintro text here\n\n## Section A\n" + "alpha ".repeat(50) + "\n\n## Section B\nbeta text";
const PROSE = "One sentence here. Two follows! Three asks? Four ends. Five closes. Six more. Seven again.";

describe("chunkFixed", () => {
  it("splits by word count with overlap and verbatim offsets", () => {
    const out = chunkFixed(WORDS, { maxTokens: 100, overlapTokens: 20 });
    assertInvariants(WORDS, out);
    expect(out.length).toBeGreaterThan(4);
    // consecutive chunks overlap: next starts before previous ends
    expect(out[1].startOffset).toBeLessThan(out[0].endOffset);
  });
  it("returns one chunk for short input and [] for empty", () => {
    expect(chunkFixed("just a few words", {})).toHaveLength(1);
    expect(chunkFixed("", {})).toEqual([]);
    expect(chunkFixed("   \n  ", {})).toEqual([]);
  });
  // A window of 0 (or a negative/fractional one) used to leave the loop unable to advance, so a
  // request body of {"maxTokens": 0} hung the worker. Every bad value must normalize instead.
  it("normalizes hostile window params instead of hanging", { timeout: 2000 }, () => {
    for (const maxTokens of [0, -1, 2.5, "abc", null, Number.NaN, Infinity]) {
      const out = chunkFixed(WORDS, { maxTokens, overlapTokens: 1 });
      assertInvariants(WORDS, out);
      expect(out.length).toBeGreaterThan(0);
    }
  });
  it("clamps overlap below the window so chunks always advance", { timeout: 2000 }, () => {
    for (const overlapTokens of [5, -3, 1000, "abc"]) {
      const out = chunkFixed(WORDS, { maxTokens: 5, overlapTokens });
      assertInvariants(WORDS, out);
      expect(out.at(-1)!.endOffset).toBe(WORDS.length);
    }
  });
});

describe("chunkHeading", () => {
  it("splits before markdown headings", () => {
    const out = chunkHeading(MD, {});
    assertInvariants(MD, out);
    expect(out.length).toBe(3);
    expect(out[1].text.startsWith("## Section A")).toBe(true);
  });
  it("hard-splits oversized sections and handles heading-free text", () => {
    const big = "no headings " + "x".repeat(10_000);
    const out = chunkHeading(big, { maxChars: 3000 });
    assertInvariants(big, out);
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(3000);
  });
  it("returns promptly for a zero or non-numeric maxChars", { timeout: 2000 }, () => {
    for (const maxChars of [0, -10, 1.5, "abc", null]) {
      const out = chunkHeading("# t\nbody", { maxChars });
      assertInvariants("# t\nbody", out);
      expect(out.length).toBeGreaterThan(0);
    }
  });
  // An out-of-range maxChars (0, negative, non-numeric) used to clamp to the 1-char minimum,
  // flooding the output with thousands of single-character chunks. It must fall back to the
  // default size instead.
  it("falls back to the default size for out-of-range maxChars instead of flooding 1-char chunks", { timeout: 2000 }, () => {
    const big = "no headings " + "x".repeat(10_000);
    for (const maxChars of [0, -10, "abc", null]) {
      const out = chunkHeading(big, { maxChars });
      assertInvariants(big, out);
      expect(out.length).toBeLessThan(10); // default (4000) yields a handful of chunks, not thousands
      for (const c of out) expect(c.text.length).toBeLessThanOrEqual(4000);
    }
  });
});

describe("chunkSentenceWindow", () => {
  it("windows sentences with overlap", () => {
    const out = chunkSentenceWindow(PROSE, { windowSentences: 3, overlapSentences: 1 });
    assertInvariants(PROSE, out);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].text).toContain("One sentence here.");
  });
  it("handles unicode text without corrupting offsets", () => {
    const uni = "Émile écrit. Ça marche bien! Encore ça? Fin.";
    assertInvariants(uni, chunkSentenceWindow(uni, { windowSentences: 2, overlapSentences: 0 }));
  });
  it("normalizes hostile window params instead of hanging", { timeout: 2000 }, () => {
    for (const windowSentences of [0, -1, 1.5, "abc", null]) {
      const out = chunkSentenceWindow(PROSE, { windowSentences, overlapSentences: 3 });
      assertInvariants(PROSE, out);
      expect(out.length).toBeGreaterThan(0);
      expect(out.at(-1)!.endOffset).toBe(PROSE.length);
    }
  });
});

describe("registry + params hash", () => {
  it("exposes all three chunkers", () => {
    expect(Object.keys(CHUNKERS).sort()).toEqual(["fixed", "heading", "sentence-window"]);
  });
  it("hashParams is stable across key order and distinct across values", () => {
    expect(hashParams({ a: 1, b: 2 })).toBe(hashParams({ b: 2, a: 1 }));
    expect(hashParams({ a: 1 })).not.toBe(hashParams({ a: 2 }));
  });
  it("hashParams distinguishes nested values and sorts nested keys", () => {
    // A key-list replacer applies at every depth, which erased nested keys entirely and collapsed
    // every distinct nested object onto the same hash.
    expect(hashParams({ a: { b: 1 } })).not.toBe(hashParams({ a: { c: 2 } }));
    expect(hashParams({ a: { b: 1, c: 2 } })).toBe(hashParams({ a: { c: 2, b: 1 } }));
    expect(hashParams({ a: [1, 2] })).not.toBe(hashParams({ a: [2, 1] }));
  });
});
