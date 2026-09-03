import { describe, it, expect } from "vitest";
import {
  buildAnswerPrompt,
  buildJudgePrompt,
  parseJudgeJson,
  mockAnswer,
  mockJudge,
} from "../src/judge";

describe("buildAnswerPrompt", () => {
  it("contains the question, the chunks, and the refusal instruction", () => {
    const prompt = buildAnswerPrompt("What is X?", ["Chunk one text.", "Chunk two text."]);
    expect(prompt).toContain("What is X?");
    expect(prompt).toContain("Chunk one text.");
    expect(prompt).toContain("Chunk two text.");
    expect(prompt).toContain("I cannot answer from the provided context");
  });
});

describe("buildJudgePrompt", () => {
  it("contains the question, gold answer, answer, chunks, and a strict-JSON instruction", () => {
    const prompt = buildJudgePrompt("What is X?", "X is Y.", "X is Y according to the text.", [
      "Some excerpt.",
    ]);
    expect(prompt).toContain("What is X?");
    expect(prompt).toContain("X is Y.");
    expect(prompt).toContain("X is Y according to the text.");
    expect(prompt).toContain("Some excerpt.");
    expect(prompt.toLowerCase()).toContain("json");
    expect(prompt).toContain("faithfulness");
    expect(prompt).toContain("correctness");
  });
});

describe("parseJudgeJson", () => {
  it("parses strict JSON with faithfulness, correctness, and reason", () => {
    const raw = '{"faithfulness": 0.8, "correctness": 1, "reason": "matches gold"}';
    expect(parseJudgeJson(raw)).toEqual({ faithfulness: 0.8, correctness: 1, reason: "matches gold" });
  });

  it("parses when fenced or surrounded by prose", () => {
    const raw = '```json\n{"faithfulness": 0.5, "correctness": 0.5, "reason": "partial"}\n```';
    expect(parseJudgeJson(raw)).toEqual({ faithfulness: 0.5, correctness: 0.5, reason: "partial" });
  });

  it("clamps out-of-range scores to [0, 1]", () => {
    const raw = '{"faithfulness": 1.5, "correctness": -0.5, "reason": "out of range"}';
    expect(parseJudgeJson(raw)).toEqual({ faithfulness: 1, correctness: 0, reason: "out of range" });
  });

  it("returns null on garbage input", () => {
    expect(parseJudgeJson("garbage")).toBeNull();
    expect(parseJudgeJson("")).toBeNull();
  });

  it("returns null when required fields are missing or wrong type", () => {
    expect(parseJudgeJson('{"faithfulness": 0.5, "correctness": "high", "reason": "x"}')).toBeNull();
    expect(parseJudgeJson('{"faithfulness": 0.5}')).toBeNull();
  });
});

describe("mockAnswer", () => {
  it("is deterministic: same input yields same output", () => {
    const chunks = ["First sentence here. Second sentence here."];
    expect(mockAnswer("What?", chunks)).toBe(mockAnswer("What?", chunks));
  });

  it("returns the first chunk's first sentence, prefixed", () => {
    const chunks = ["First sentence here. Second sentence ignored.", "Other chunk."];
    expect(mockAnswer("What?", chunks)).toBe("Based on the context: First sentence here.");
  });

  it("uses the whole chunk when no sentence boundary is found", () => {
    const chunks = ["no punctuation in this chunk at all"];
    expect(mockAnswer("What?", chunks)).toBe("Based on the context: no punctuation in this chunk at all");
  });

  it("returns the refusal string verbatim for an empty chunks array", () => {
    expect(mockAnswer("What?", [])).toBe("I cannot answer from the provided context");
  });
});

describe("mockJudge", () => {
  it("is deterministic: same input yields same output", () => {
    expect(mockJudge("The sky is blue today.", "The sky is blue today.")).toEqual(
      mockJudge("The sky is blue today.", "The sky is blue today."),
    );
  });

  it("scores 1/1 when the answer contains the gold answer's first five words", () => {
    const gold = "The mitochondria is the powerhouse of the cell.";
    const answer = "Based on the context: The mitochondria is the powerhouse of the cell.";
    expect(mockJudge(gold, answer)).toEqual({
      faithfulness: 1,
      correctness: 1,
      reason: expect.any(String),
    });
  });

  it("scores 0/0 when the answer does not contain the gold answer's first five words", () => {
    const gold = "The mitochondria is the powerhouse of the cell.";
    const answer = "I cannot answer from the provided context";
    expect(mockJudge(gold, answer)).toEqual({
      faithfulness: 0,
      correctness: 0,
      reason: expect.any(String),
    });
  });

  it("uses all available words when the gold answer has fewer than five", () => {
    const gold = "Yes it is.";
    const answer = "The document confirms: Yes it is.";
    expect(mockJudge(gold, answer).correctness).toBe(1);
  });

  it("tolerates irregular whitespace via normalizeWs on both sides", () => {
    const gold = "The   mitochondria\nis the powerhouse of the cell.";
    const answer = "Based on the context: The mitochondria is the powerhouse of the cell.";
    expect(mockJudge(gold, answer).correctness).toBe(1);
  });
});
