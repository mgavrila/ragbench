import OpenAI from "openai";
import { EMBEDDING_MODELS } from "../registry";
import type { EmbeddingProvider, UsageReporter } from "./types";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  readonly dimension: number;
  constructor(readonly model: string, private report?: UsageReporter) {
    this.client = new OpenAI();
    this.dimension = EMBEDDING_MODELS[model].dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await this.client.embeddings.create({ model: this.model, input: batch });
      await this.report?.({
        purpose: "embed",
        provider: "openai",
        model: this.model,
        inputTokens: res.usage.total_tokens,
        outputTokens: 0,
      });
      for (const d of res.data) out.push(d.embedding);
    }
    return out;
  }
}
