import { describe, it, expect } from "vitest";
import { ProviderError, toProviderError } from "../src/providers/errors";

function httpErr(status: number) {
  const e = new Error(`http ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

describe("provider error taxonomy", () => {
  it("maps status codes to kinds", () => {
    expect(toProviderError("anthropic", httpErr(429)).kind).toBe("rate_limit");
    expect(toProviderError("openai", httpErr(401)).kind).toBe("auth");
    expect(toProviderError("openai", httpErr(403)).kind).toBe("auth");
    expect(toProviderError("google", httpErr(500)).kind).toBe("transient");
    expect(toProviderError("google", httpErr(529)).kind).toBe("transient");
    expect(toProviderError("anthropic", httpErr(400)).kind).toBe("fatal");
  });

  it("treats connection-ish errors as transient", () => {
    const e = new Error("fetch failed") as Error & { code: string };
    e.code = "ECONNRESET";
    expect(toProviderError("openai", e).kind).toBe("transient");
  });

  it("marks retryable correctly and preserves cause + provider", () => {
    const pe = toProviderError("anthropic", httpErr(429));
    expect(pe.retryable).toBe(true);
    expect(pe.provider).toBe("anthropic");
    expect(pe.cause).toBeInstanceOf(Error);
    expect(toProviderError("anthropic", httpErr(400)).retryable).toBe(false);
    expect(toProviderError("anthropic", httpErr(401)).retryable).toBe(false);
  });

  it("passes through an existing ProviderError unchanged", () => {
    const orig = new ProviderError("fatal", "anthropic", "nope");
    expect(toProviderError("anthropic", orig)).toBe(orig);
  });
});
