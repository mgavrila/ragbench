export const LLM_MODELS: Record<
  string,
  { provider: "anthropic" | "google" | "mock"; inputPerMTok: number; outputPerMTok: number }
> = {
  "claude-opus-5": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25 },
  "claude-haiku-4-5": { provider: "anthropic", inputPerMTok: 1, outputPerMTok: 5 },
  "gemini-2.5-flash": { provider: "google", inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "mock-llm": { provider: "mock", inputPerMTok: 0, outputPerMTok: 0 },
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
/** Cheapest real LLM. Gemini's *API tier* is free; the model itself is $0.30/$2.50 per MTok. */
export const BUDGET_LLM = "gemini-2.5-flash";

/**
 * Model names arrive from request bodies and job payloads, so registry lookups go through
 * `Object.hasOwn`: a plain `LLM_MODELS[name]` also resolves inherited keys, and "constructor" or
 * "toString" would sail past a truthiness check and reach the pricing math as a function.
 */
export function lookupLlmModel(model: string): (typeof LLM_MODELS)[string] | undefined {
  return Object.hasOwn(LLM_MODELS, model) ? LLM_MODELS[model] : undefined;
}

export function lookupEmbeddingModel(model: string): (typeof EMBEDDING_MODELS)[string] | undefined {
  return Object.hasOwn(EMBEDDING_MODELS, model) ? EMBEDDING_MODELS[model] : undefined;
}

export function estimateLlmCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const m = lookupLlmModel(model);
  if (!m) throw new Error(`unknown LLM model: ${model}`);
  return (inputTokens * m.inputPerMTok + outputTokens * m.outputPerMTok) / 1_000_000;
}

export function estimateEmbeddingCostUsd(model: string, tokens: number): number {
  const m = lookupEmbeddingModel(model);
  if (!m) throw new Error(`unknown embedding model: ${model}`);
  return (tokens * m.pricePerMTok) / 1_000_000;
}
