import { describe, it, expect } from "vitest";
import { hashEmbed, MockEmbeddingProvider, MockLLMProvider } from "../src/providers/mock";
import type { UsageReporter } from "../src/providers/types";
import { makeEmbedder, makeLLM } from "../src/providers/factory";
import { estimateLlmCostUsd } from "../src/registry";

type UsageEvent = Parameters<UsageReporter>[0];

function cosine(a: number[], b: number[]) {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  return dot; // vectors are unit-normalized
}

describe("hashEmbed", () => {
  it("is deterministic and unit-length", () => {
    const v1 = hashEmbed("the quick brown fox");
    const v2 = hashEmbed("the quick brown fox");
    expect(v1).toEqual(v2);
    expect(Math.hypot(...v1)).toBeCloseTo(1);
  });

  it("returns a unit vector for token-less input", () => {
    expect(Math.hypot(...hashEmbed("  ...  "))).toBeCloseTo(1);
  });

  it("scores overlapping texts higher than disjoint texts", () => {
    const q = hashEmbed("postgres connection pooling limits");
    const near = hashEmbed("limits on postgres connection pooling explained");
    const far = hashEmbed("baking sourdough bread at home");
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });
});

describe("mock providers", () => {
  it("embeds batches at the declared dimension", async () => {
    const p = new MockEmbeddingProvider();
    const out = await p.embed(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(p.dimension);
  });

  it("replays canned responses then echoes", async () => {
    const llm = new MockLLMProvider(["first", "second"]);
    expect(await llm.complete({ prompt: "x" })).toBe("first");
    expect(await llm.complete({ prompt: "y" })).toBe("second");
    expect(await llm.complete({ prompt: "z" })).toBe("MOCK: z");
  });

  // Keyless demo runs go through the mocks, so metering has to work there too or the usage log
  // comes out empty.
  it("reports usage so keyless runs still meter", async () => {
    const seen: UsageEvent[] = [];
    const report: UsageReporter = (u) => { seen.push(u); };

    await new MockEmbeddingProvider(report).embed(["one two", "three"]);
    await new MockLLMProvider(["a canned reply"], report, "generate-testset")
      .complete({ system: "sys", prompt: "two words" });

    expect(seen).toEqual([
      { purpose: "embed", provider: "mock", model: "mock-embedding", inputTokens: 3, outputTokens: 0 },
      { purpose: "generate-testset", provider: "mock", model: "mock-llm", inputTokens: 3, outputTokens: 3 },
    ]);
    // Mock usage is metered but free: the registry prices both mock models at zero.
    expect(estimateLlmCostUsd("mock-llm", 3, 3)).toBe(0);
  });

  it("wires the reporter through the factory", async () => {
    const seen: UsageEvent[] = [];
    await makeLLM("mock-llm", (u) => { seen.push(u); }, "evaluate-question")
      .complete({ prompt: "hi there" });
    await makeEmbedder("mock-embedding", (u) => { seen.push(u); }).embed(["hi there"]);
    expect(seen.map((u) => u.purpose)).toEqual(["evaluate-question", "embed"]);
  });
});
