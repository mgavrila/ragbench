import { LLM_MODELS, EMBEDDING_MODELS } from "../registry";
import type { EmbeddingProvider, LLMProvider, UsageReporter } from "./types";
import { MockEmbeddingProvider, MockLLMProvider } from "./mock";
import { AnthropicLLMProvider } from "./anthropic";
import { OpenAIEmbeddingProvider } from "./openai";
import { GeminiLLMProvider, GeminiEmbeddingProvider } from "./google";

export function makeLLM(model: string, report?: UsageReporter, purpose?: string): LLMProvider {
  const entry = LLM_MODELS[model];
  if (!entry) throw new Error(`unknown LLM model: ${model}`);
  if (entry.provider === "mock") return new MockLLMProvider([], report, purpose);
  if (entry.provider === "google") return new GeminiLLMProvider(model, report, purpose);
  return new AnthropicLLMProvider(model, report, purpose);
}

export function makeEmbedder(model: string, report?: UsageReporter): EmbeddingProvider {
  const entry = EMBEDDING_MODELS[model];
  if (!entry) throw new Error(`unknown embedding model: ${model}`);
  if (entry.provider === "mock") return new MockEmbeddingProvider(report);
  if (entry.provider === "google") return new GeminiEmbeddingProvider(model, report);
  return new OpenAIEmbeddingProvider(model, report);
}
