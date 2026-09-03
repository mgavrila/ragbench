import { GoogleGenAI } from "@google/genai";
import { EMBEDDING_MODELS } from "../registry";
import type { EmbeddingProvider, LLMProvider, UsageReporter } from "./types";

export class GeminiLLMProvider implements LLMProvider {
  private client: GoogleGenAI;
  constructor(
    readonly model: string,
    private report?: UsageReporter,
    private purpose = "llm",
  ) {
    this.client = new GoogleGenAI();
  }

  async complete({ system, prompt, maxTokens = 4096 }: {
    system?: string; prompt: string; maxTokens?: number;
  }): Promise<string> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { systemInstruction: system, maxOutputTokens: maxTokens },
    });
    await this.report?.({
      purpose: this.purpose,
      provider: "google",
      model: this.model,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    });
    if (!response.text) {
      throw new Error("LLM returned no text");
    }
    return response.text;
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private client: GoogleGenAI;
  readonly dimension: number;
  constructor(readonly model: string, private report?: UsageReporter) {
    this.client = new GoogleGenAI();
    this.dimension = EMBEDDING_MODELS[model].dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await this.client.models.embedContent({
        model: this.model,
        contents: batch,
        config: { outputDimensionality: this.dimension },
      });
      // The Gemini API does not report a token count for embedContent responses
      // (only the Gemini Enterprise Agent Platform does, via per-embedding
      // statistics); default to 0 in that case.
      await this.report?.({
        purpose: "embed",
        provider: "google",
        model: this.model,
        inputTokens: 0,
        outputTokens: 0,
      });
      for (const e of res.embeddings ?? []) out.push(e.values ?? []);
    }
    return out;
  }
}
