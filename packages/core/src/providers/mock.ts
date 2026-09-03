import type { EmbeddingProvider, LLMProvider, UsageReporter } from "./types";

export function hashEmbed(text: string, dim = 256): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % dim] += 1;
  }
  // Token-less input (empty string, punctuation only) would otherwise leave an all-zero vector:
  // not unit-length, and NaN once anything divides by its magnitude under cosine. Fall back to a
  // fixed unit vector so every input embeds to something comparable.
  if (tokens.length === 0) v[0] = 1;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** Stand-in for a real tokenizer: the mocks only need a plausible, monotonic count. */
function estimateTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-embedding";
  readonly dimension = 256;
  constructor(private report?: UsageReporter) {}

  async embed(texts: string[]): Promise<number[][]> {
    await this.report?.({
      purpose: "embed",
      provider: "mock",
      model: this.model,
      inputTokens: texts.reduce((n, t) => n + estimateTokens(t), 0),
      outputTokens: 0,
    });
    return texts.map((t) => hashEmbed(t, this.dimension));
  }
}

export class MockLLMProvider implements LLMProvider {
  readonly model = "mock-llm";
  private queue: string[];
  constructor(
    responses: string[] = [],
    private report?: UsageReporter,
    private purpose = "llm",
  ) {
    this.queue = [...responses];
  }

  async complete({ system, prompt }: { system?: string; prompt: string }): Promise<string> {
    const text = this.queue.shift() ?? `MOCK: ${prompt}`;
    await this.report?.({
      purpose: this.purpose,
      provider: "mock",
      model: this.model,
      inputTokens: estimateTokens(system ?? "") + estimateTokens(prompt),
      outputTokens: estimateTokens(text),
    });
    return text;
  }
}
