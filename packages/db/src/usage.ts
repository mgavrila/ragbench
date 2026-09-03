import {
  LLM_MODELS, EMBEDDING_MODELS, estimateLlmCostUsd, estimateEmbeddingCostUsd,
  type UsageReporter,
} from "@ragbench/core";
import { usageLog } from "./schema";
import type { Db } from "./client";

export function makeUsageReporter(db: Db, organizationId: string): UsageReporter {
  return async ({ purpose, provider, model, inputTokens, outputTokens }) => {
    let costUsd = 0;
    if (LLM_MODELS[model]) costUsd = estimateLlmCostUsd(model, inputTokens, outputTokens);
    else if (EMBEDDING_MODELS[model]) costUsd = estimateEmbeddingCostUsd(model, inputTokens);
    await db.insert(usageLog).values({ organizationId, purpose, provider, model, inputTokens, outputTokens, costUsd });
  };
}
