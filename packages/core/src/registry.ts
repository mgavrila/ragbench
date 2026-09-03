export const LLM_MODELS: Record<
  string,
  { provider: "anthropic" | "google"; inputPerMTok: number; outputPerMTok: number }
> = {
  "claude-opus-5": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25 },
  "claude-haiku-4-5": { provider: "anthropic", inputPerMTok: 1, outputPerMTok: 5 },
  "gemini-2.5-flash": { provider: "google", inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

export const EMBEDDING_MODELS: Record<
  string,
  { provider: "openai" | "google" | "mock"; dimension: number; pricePerMTok: number }
> = {
  "text-embedding-3-small": { provider: "openai", dimension: 1536, pricePerMTok: 0.02 },
  "text-embedding-3-large": { provider: "openai", dimension: 3072, pricePerMTok: 0.13 },
  "gemini-embedding-001": { provider: "google", dimension: 1536, pricePerMTok: 0.15 },
  "mock-embedding": { provider: "mock", dimension: 256, pricePerMTok: 0 },
};

export const DEFAULT_LLM = "claude-opus-5";
export const CHEAP_LLM = "claude-haiku-4-5";
export const DEFAULT_EMBEDDER = "text-embedding-3-small";
export const FREE_LLM = "gemini-2.5-flash";

export function estimateLlmCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const m = LLM_MODELS[model];
  if (!m) throw new Error(`unknown LLM model: ${model}`);
  return (inputTokens * m.inputPerMTok + outputTokens * m.outputPerMTok) / 1_000_000;
}

export function estimateEmbeddingCostUsd(model: string, tokens: number): number {
  const m = EMBEDDING_MODELS[model];
  if (!m) throw new Error(`unknown embedding model: ${model}`);
  return (tokens * m.pricePerMTok) / 1_000_000;
}
