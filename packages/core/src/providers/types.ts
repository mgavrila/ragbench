export type Usage = { inputTokens: number; outputTokens: number };

export type UsageReporter = (
  u: { purpose: string; provider: string; model: string } & Usage,
) => void | Promise<void>;

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface LLMProvider {
  readonly model: string;
  complete(opts: { system?: string; prompt: string; maxTokens?: number }): Promise<string>;
}
