import type { EmbeddingProvider, LLMProvider } from "./types";

export function hashEmbed(text: string, dim = 256): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % dim] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-embedding";
  readonly dimension = 256;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dimension));
  }
}

export class MockLLMProvider implements LLMProvider {
  readonly model = "mock-llm";
  private queue: string[];
  constructor(responses: string[] = []) {
    this.queue = [...responses];
  }
  async complete({ prompt }: { system?: string; prompt: string }): Promise<string> {
    return this.queue.shift() ?? `MOCK: ${prompt}`;
  }
}
