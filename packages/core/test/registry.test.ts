import { describe, it, expect } from "vitest";
import {
  LLM_MODELS, EMBEDDING_MODELS, DEFAULT_LLM, DEFAULT_EMBEDDER,
  estimateLlmCostUsd, estimateEmbeddingCostUsd,
} from "../src/registry";

describe("model registry", () => {
  it("has the default models", () => {
    expect(LLM_MODELS[DEFAULT_LLM]).toBeDefined();
    expect(EMBEDDING_MODELS[DEFAULT_EMBEDDER].dimension).toBe(1536);
  });

  it("computes LLM cost from per-MTok prices", () => {
    // claude-opus-5: $5 in / $25 out per MTok
    expect(estimateLlmCostUsd("claude-opus-5", 1_000_000, 1_000_000)).toBeCloseTo(30);
    expect(estimateLlmCostUsd("claude-haiku-4-5", 2_000_000, 0)).toBeCloseTo(2);
  });

  it("computes embedding cost", () => {
    expect(estimateEmbeddingCostUsd("text-embedding-3-small", 1_000_000)).toBeCloseTo(0.02);
  });

  it("throws on unknown models", () => {
    expect(() => estimateLlmCostUsd("gpt-nope", 1, 1)).toThrow(/unknown/i);
  });
});
