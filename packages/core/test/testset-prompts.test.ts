import { describe, it, expect } from "vitest";
import {
  buildGenerationPrompt,
  buildTrivialityGatePrompt,
  parseGateJson,
  mockGenerateQa,
} from "../src/testset-prompts";
import { verifyQuote } from "../src/testset";

describe("buildGenerationPrompt", () => {
  it("contains the passage, the count, and a JSON-array instruction", () => {
    const passage = "This is the source passage text for generation.";
    const prompt = buildGenerationPrompt(passage, 5);
    expect(prompt).toContain(passage);
    expect(prompt).toContain("5");
    expect(prompt.toLowerCase()).toContain("json");
    expect(prompt).toContain("[");
  });
});

describe("buildTrivialityGatePrompt", () => {
  it("contains the question, the quote, and a strict-JSON boolean instruction", () => {
    const prompt = buildTrivialityGatePrompt("What is X?", "X is the quoted answer text.");
    expect(prompt).toContain("What is X?");
    expect(prompt).toContain("X is the quoted answer text.");
    expect(prompt.toLowerCase()).toContain("json");
    expect(prompt).toContain("trivial");
  });
});

describe("parseGateJson", () => {
  it("parses a strict JSON boolean object", () => {
    expect(parseGateJson('{"trivial":true}')).toBe(true);
    expect(parseGateJson('{"trivial":false}')).toBe(false);
  });

  it("parses when fenced or surrounded by prose", () => {
    expect(parseGateJson('```json\n{"trivial": true}\n```')).toBe(true);
    expect(parseGateJson('Here you go:\n{"trivial": false}\nDone.')).toBe(false);
  });

  it("returns null on unparseable input (fail open)", () => {
    expect(parseGateJson("garbage")).toBeNull();
    expect(parseGateJson("")).toBeNull();
    expect(parseGateJson('{"other": true}')).toBeNull();
  });
});

describe("mockGenerateQa", () => {
  const passage = {
    text:
      "The mitochondria is the powerhouse of the cell and produces ATP. " +
      "Photosynthesis converts light energy into chemical energy in plants. " +
      "The water cycle describes how water moves through the environment continuously. " +
      "Short one. " +
      "Gravity is a fundamental force that attracts two bodies with mass toward each other.",
    start: 100,
  };

  it("is deterministic: same input yields same output", () => {
    const a = mockGenerateQa(passage, 3);
    const b = mockGenerateQa(passage, 3);
    expect(a).toEqual(b);
  });

  it("respects n, skipping sentences under 30 chars", () => {
    const out = mockGenerateQa(passage, 3);
    expect(out.length).toBe(3);
    for (const qa of out) expect(qa.quote.length).toBeGreaterThanOrEqual(30);
  });

  it("produces quotes that are verbatim substrings of the passage, verifiable via verifyQuote", () => {
    const out = mockGenerateQa(passage, 3);
    for (const qa of out) {
      expect(passage.text).toContain(qa.quote);
      const hit = verifyQuote(passage.text, qa.quote);
      expect(hit).not.toBeNull();
    }
  });

  it("sets answer equal to the quote and builds a question from the first five words", () => {
    const out = mockGenerateQa(passage, 1);
    expect(out[0].answer).toBe(out[0].quote);
    const firstFiveWords = out[0].quote.trim().split(/\s+/).slice(0, 5).join(" ");
    expect(out[0].question).toBe(`What does the document state about ${firstFiveWords}?`);
  });

  it("returns fewer than n when there aren't enough qualifying sentences", () => {
    const tiny = { text: "Short one. Also short.", start: 0 };
    const out = mockGenerateQa(tiny, 5);
    expect(out.length).toBe(0);
  });

  it("drops the leading mid-sentence fragment of a passage that starts inside the document", () => {
    // samplePassages cuts on word boundaries, so a passage with start > 0 opens mid-sentence. The
    // fragment here is 63 chars -- well past the 30-char floor -- so only the start offset can tell
    // it apart from a real sentence.
    const fragment = "quantity reached level 161 during the trial period of the study.";
    const passage = {
      text: `${fragment} Sentence 27 explains that the measured quantity reached level 189 during the trial.`,
      start: 2404,
    };

    const out = mockGenerateQa(passage, 5);

    expect(out.length).toBeGreaterThan(0);
    for (const qa of out) {
      expect(qa.answer).not.toBe(fragment);
      expect(qa.quote).not.toBe(fragment);
    }
    // Same text at the head of the document keeps the sentence: only the offset makes it a fragment.
    expect(mockGenerateQa({ text: passage.text, start: 0 }, 5)[0].answer).toBe(fragment);
  });
});
