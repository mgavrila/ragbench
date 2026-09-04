import {
  estimateLlmCostUsd, estimateEmbeddingCostUsd, lookupEmbeddingModel, lookupLlmModel,
  type UsageReporter,
} from "@ragbench/core";
import { usageLog } from "./schema";
import type { Db } from "./client";

export function makeUsageReporter(db: Db, organizationId: string): UsageReporter {
  return async ({ purpose, provider, model, inputTokens, outputTokens }) => {
    // Metering can never fail or reclassify a paid provider call: the usage log is an advisory
    // cost display, not part of any handler's success/failure path. At-least-once metering is
    // accepted for v1 -- a lost log row understates cost, which is far cheaper than a logging bug
    // turning a successful embed/generate/judge call into a retried (and double-billed) one.
    //
    // The pricing lookup is inside the try for the same reason. `model` reaches here from job
    // payloads and request bodies, so it is arbitrary text; the lookup* helpers reject inherited
    // Object keys ("constructor", "toString") that a bare index would have resolved to a function
    // and handed to the pricing math, but an unknown model still has to log at zero cost rather
    // than throw out of the reporter.
    try {
      let costUsd = 0;
      if (lookupLlmModel(model)) costUsd = estimateLlmCostUsd(model, inputTokens, outputTokens);
      else if (lookupEmbeddingModel(model)) costUsd = estimateEmbeddingCostUsd(model, inputTokens);
      await db.insert(usageLog).values({ organizationId, purpose, provider, model, inputTokens, outputTokens, costUsd });
    } catch (err) {
      console.error("usage reporter failed to log usage", err);
    }
  };
}
