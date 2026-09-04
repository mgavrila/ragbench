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

  it("truncates a runaway provider message to the stored cap", () => {
    // Providers that echo the request back turn one failed job into a multi-megabyte error column.
    const long = new Error("x".repeat(5000));
    const message = toProviderError("openai", long).message;
    expect(message).toHaveLength(300);
    expect(message.endsWith("...")).toBe(true);
  });

  it("redacts anything shaped like an API key before it can be stored", () => {
    const leaked = new Error("401 Incorrect API key provided: sk-proj-AbC123xyz-9. Check your key.");
    const message = toProviderError("openai", leaked).message;
    expect(message).toContain("sk-***");
    expect(message).not.toContain("AbC123xyz");

    // Real keys from both vendors are base64url, so they contain underscores. A character class
    // without `_` matches only up to the first one and leaves the rest of the key sitting in the
    // stored message.
    const underscored = new Error("401 invalid key sk-ant-api03-Ab_cD3f_gH1jK2-lMn0 rejected");
    const redacted = toProviderError("anthropic", underscored).message;
    expect(redacted).toContain("sk-***");
    expect(redacted).not.toContain("cD3f");
    expect(redacted).not.toContain("gH1jK2");
    expect(redacted).toBe("401 invalid key sk-*** rejected");

    // A key near the cut is stripped rather than half-surviving. (Both orderings happen to strip
    // this one -- truncating first would leave a shorter prefix that still matches the pattern --
    // so this pins the outcome, not the order the two steps run in.)
    const buried = new Error(`${"x".repeat(290)} sk-proj-SECRETKEYVALUE`);
    expect(toProviderError("openai", buried).message).not.toContain("SECRET");
  });

  it("redacts a Google (AIza-prefixed) key the same way", () => {
    // Defense-in-depth: the Gemini SDK sends the key in a header rather than the body, so this
    // shape is not expected to come back from a real error, but the pattern covers it anyway.
    const leaked = new Error("400 API key not valid: AIzaSyD-9vN3kR7wXyZ0aBcDeFgHiJkLmNoPqRs rejected");
    const message = toProviderError("gemini", leaked).message;
    expect(message).toContain("AIza***");
    expect(message).not.toContain("9vN3kR7wXyZ0");
    expect(message).toBe("400 API key not valid: AIza*** rejected");
  });

  it("leaves an ordinary message exactly as the provider wrote it", () => {
    const plain = new Error("model gpt-4o-mini does not support this endpoint");
    expect(toProviderError("openai", plain).message)
      .toBe("model gpt-4o-mini does not support this endpoint");
  });

  it("maps a malformed-response parse failure (TypeError, no status) to fatal", () => {
    // Real providers now wrap the SDK call *and* the response parsing that follows it
    // (usage reporting, field access) in the same try/catch, rethrowing via
    // toProviderError. A TypeError thrown while reading an unexpected response shape
    // has no status/code, so it lands here — this is the taxonomy's side of that contract.
    const parseErr = new TypeError("Cannot read properties of undefined (reading 'input_tokens')");
    const pe = toProviderError("anthropic", parseErr);
    expect(pe.kind).toBe("fatal");
    expect(pe.retryable).toBe(false);
    expect(pe.cause).toBe(parseErr);
  });
});
