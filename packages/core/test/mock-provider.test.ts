import { describe, it, expect } from "vitest";
import { hashEmbed, MockEmbeddingProvider, MockLLMProvider } from "../src/providers/mock";

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
});
