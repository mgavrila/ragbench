import { describe, it, expect } from "vitest";
import { makeLLM, makeEmbedder } from "../src/providers/factory";
import { MockEmbeddingProvider, MockLLMProvider } from "../src/providers/mock";
import { estimateLlmCostUsd } from "../src/registry";

describe("provider factory", () => {
  it("returns mock providers for mock models without needing keys", () => {
    expect(makeLLM("mock-llm")).toBeInstanceOf(MockLLMProvider);
    expect(makeEmbedder("mock-embedding")).toBeInstanceOf(MockEmbeddingProvider);
  });

  it("constructs real providers for registry models (no network call)", () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    process.env.OPENAI_API_KEY ??= "test-key";
    expect(makeLLM("claude-opus-5").model).toBe("claude-opus-5");
    expect(makeEmbedder("text-embedding-3-small").dimension).toBe(1536);
  });

  it("rejects unknown models", () => {
    expect(() => makeLLM("nope")).toThrow(/unknown/i);
    expect(() => makeEmbedder("nope")).toThrow(/unknown/i);
  });

  it("constructs Gemini providers for registry models (no network call)", () => {
    process.env.GEMINI_API_KEY ??= "test-key";
    expect(makeLLM("gemini-2.5-flash").model).toBe("gemini-2.5-flash");
    expect(makeEmbedder("gemini-embedding-001").dimension).toBe(1536);
    expect(estimateLlmCostUsd("gemini-2.5-flash", 1_000_000, 0)).toBeCloseTo(0.3);
  });
});
