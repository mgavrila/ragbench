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
    // Metering can never fail or reclassify a paid provider call: the usage log is an advisory
    // cost display, not part of any handler's success/failure path. At-least-once metering is
    // accepted for v1 -- a lost log row understates cost, which is far cheaper than a logging bug
    // turning a successful embed/generate/judge call into a retried (and double-billed) one.
    try {
      await db.insert(usageLog).values({ organizationId, purpose, provider, model, inputTokens, outputTokens, costUsd });
    } catch (err) {
      console.error("usage reporter failed to log usage", err);
    }
  };
}
