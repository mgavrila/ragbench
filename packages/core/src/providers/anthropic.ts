import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, UsageReporter } from "./types";
import { ProviderError, toProviderError } from "./errors";

export class AnthropicLLMProvider implements LLMProvider {
  private client: Anthropic;
  constructor(
    readonly model: string,
    private report?: UsageReporter,
    private purpose = "llm",
  ) {
    this.client = new Anthropic();
  }

  async complete({ system, prompt, maxTokens = 4096 }: {
    system?: string; prompt: string; maxTokens?: number;
  }): Promise<string> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
      });
    } catch (err) {
      throw toProviderError("anthropic", err);
    }
    await this.report?.({
      purpose: this.purpose,
      provider: "anthropic",
      model: this.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
    const text = response.content.find((b) => b.type === "text");
    if (response.stop_reason === "refusal" || !text) {
      throw new ProviderError("fatal", "anthropic", `LLM returned no text (stop_reason=${response.stop_reason})`);
    }
    return text.text;
  }
}
