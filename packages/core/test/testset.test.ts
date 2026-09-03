import { describe, it, expect } from "vitest";
import { normalizeWs, verifyQuote, samplePassages, parseQaJson } from "../src/testset";

describe("normalizeWs", () => {
  it("collapses whitespace runs and trims", () => {
    expect(normalizeWs("  a   b\n\tc  ")).toBe("a b c");
    expect(normalizeWs("a\n\nb")).toBe("a b");
    expect(normalizeWs("")).toBe("");
  });
});

describe("verifyQuote", () => {
  function assertSpan(doc: string, quote: string) {
    const hit = verifyQuote(doc, quote);
    expect(hit).not.toBeNull();
    if (hit) expect(normalizeWs(doc.slice(hit.start, hit.end))).toBe(normalizeWs(quote));
    return hit;
  }

  it("finds an exact match", () => {
    const doc = "The quick brown fox jumps over the lazy dog.";
    const hit = assertSpan(doc, "quick brown fox jumps");
    expect(doc.slice(hit!.start, hit!.end)).toBe("quick brown fox jumps");
  });

  it("tolerates different internal whitespace/newlines than the doc", () => {
    const doc = "Alpha  beta\ngamma   delta epsilon zeta.";
    assertSpan(doc, "beta gamma delta");
  });

  it("matches a quote at the very start of the document", () => {
    const doc = "Leading phrase right here, then more text follows after it.";
    const hit = assertSpan(doc, "Leading phrase right here");
    expect(hit!.start).toBe(0);
  });

  it("matches a quote at the very end of the document", () => {
    const doc = "Some intro text goes here before the trailing phrase ends now";
    const hit = assertSpan(doc, "trailing phrase ends now");
    expect(hit!.end).toBe(doc.length);
  });

  it("returns null when the quote is absent", () => {
    const doc = "Nothing here matches anything relevant at all today.";
    expect(verifyQuote(doc, "this text is nowhere present")).toBeNull();
  });

  it("returns null for a quote shorter than 12 normalized chars", () => {
    const doc = "Short quotes should not verify against long documents here.";
    expect(verifyQuote(doc, "Short")).toBeNull();
    expect(verifyQuote(doc, "a b")).toBeNull();
  });

  it("handles unicode text", () => {
    const doc = "Émile écrit un très long paragraphe ici. Ça marche bien pour lui.";
    assertSpan(doc, "écrit un très long paragraphe");
  });

  it("first match wins among overlapping/repeated candidates", () => {
    const doc = "repeated phrase here, and then repeated phrase here again later.";
    const hit = assertSpan(doc, "repeated phrase here");
    expect(hit!.start).toBe(0);
  });

  it("maps whitespace-differing quote spans back through the original text exactly", () => {
    const doc = "line one\n  line two   with   extra   spacing\nline three continues";
    const hit = assertSpan(doc, "line two with extra spacing");
    expect(doc.slice(hit!.start, hit!.end)).toContain("line two");
  });
});

describe("samplePassages", () => {
  it("yields count non-overlapping spans covering spread positions for a long doc", () => {
    const doc = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const out = samplePassages(doc, 4, 200);
    expect(out.length).toBe(4);
    for (const p of out) expect(doc.slice(p.start, p.end)).toBe(p.text);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
    // spread across the doc, not all bunched at the start
    expect(out.at(-1)!.start).toBeGreaterThan(out[0].start + 500);
  });

  it("yields one passage for a short doc", () => {
    const doc = "This is a short document that fits in a single passage easily.";
    const out = samplePassages(doc, 5, 1200);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe(doc.trim() === doc ? doc : out[0].text);
    expect(doc.slice(out[0].start, out[0].end)).toBe(out[0].text);
  });

  it("returns [] for count 0", () => {
    const doc = "Any document text goes here regardless of length for this case.";
    expect(samplePassages(doc, 0)).toEqual([]);
  });

  it("snaps spans to whitespace boundaries (no partial-word cuts)", () => {
    const doc = Array.from({ length: 300 }, (_, i) => `token${i}`).join(" ");
    const out = samplePassages(doc, 3, 150);
    for (const p of out) {
      if (p.start > 0) expect(doc[p.start - 1]).toMatch(/\s/);
      if (p.end < doc.length) expect(doc[p.end]).toMatch(/\s|$/);
    }
  });

  it("uses default passageChars of ~1200 when not specified", () => {
    const doc = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
    const out = samplePassages(doc, 2);
    for (const p of out) expect(p.text.length).toBeLessThanOrEqual(1400);
  });
});

describe("parseQaJson", () => {
  it("parses a bare JSON array", () => {
    const raw = '[{"question":"Q1","answer":"A1","quote":"Q1 text"}]';
    expect(parseQaJson(raw)).toEqual([{ question: "Q1", answer: "A1", quote: "Q1 text" }]);
  });

  it("parses a fenced ```json array", () => {
    const raw = '```json\n[{"question":"Q","answer":"A","quote":"C"}]\n```';
    expect(parseQaJson(raw)).toEqual([{ question: "Q", answer: "A", quote: "C" }]);
  });

  it("parses an array embedded in surrounding prose", () => {
    const raw = 'Sure, here is the JSON:\n[{"question":"Q","answer":"A","quote":"C"}]\nHope that helps!';
    expect(parseQaJson(raw)).toEqual([{ question: "Q", answer: "A", quote: "C" }]);
  });

  it("returns [] for unparseable garbage", () => {
    expect(parseQaJson("not json at all")).toEqual([]);
    expect(parseQaJson("")).toEqual([]);
  });

  it("filters entries missing any of the three required string fields", () => {
    const raw = JSON.stringify([
      { question: "Q1", answer: "A1", quote: "C1" },
      { question: "Q2", answer: "A2" },
      { question: "Q3", quote: "C3" },
      { answer: "A4", quote: "C4" },
      { question: "Q5", answer: "A5", quote: 5 },
      { question: "Q6", answer: "A6", quote: "C6" },
    ]);
    expect(parseQaJson(raw)).toEqual([
      { question: "Q1", answer: "A1", quote: "C1" },
      { question: "Q6", answer: "A6", quote: "C6" },
    ]);
  });

  it("skips an unrelated earlier bracket and finds the real QA array", () => {
    const raw = 'The value at data[0] is interesting. Anyway: [{"question":"Q","answer":"A","quote":"C"}]';
    expect(parseQaJson(raw)).toEqual([{ question: "Q", answer: "A", quote: "C" }]);
  });

  it("skips a numeric-array bracket in prose before the real array", () => {
    const raw = 'See item[1,2,3] for context, then: [{"question":"Q","answer":"A","quote":"C"}]';
    expect(parseQaJson(raw)).toEqual([{ question: "Q", answer: "A", quote: "C" }]);
  });

  it("returns [] when prose brackets exist but no valid QA array is present anywhere", () => {
    const raw = "The value at data[0] and item[1,2,3] are both just noise here.";
    expect(parseQaJson(raw)).toEqual([]);
  });
});
