export type ProviderErrorKind = "rate_limit" | "auth" | "transient" | "fatal";

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.retryable = kind === "rate_limit" || kind === "transient";
  }
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

/**
 * These messages are stored (documents.error, test_sets.error, chunk_sets.embed_error,
 * question_results.error) and rendered, so they are treated as untrusted output on two counts.
 *
 * Length: a provider that echoes the whole request body back in an error turns one failed job into
 * a multi-megabyte row and an unreadable page. 300 characters is enough for every real provider
 * message (status line plus reason) and is the house cap for all of them.
 *
 * Secrets: some SDKs include the offending Authorization header or key prefix in the message. An
 * API key that reaches a database row is an API key in every backup and screenshot of it, so
 * anything shaped like one is replaced before the message is ever stored. Covers OpenAI/Anthropic
 * keys (`sk-proj-...`, `sk-ant-...`) and Google keys (`AIza...`). The character class includes `_`
 * because these are base64url, and a class without it stops matching at the first underscore --
 * leaving the rest of the key readable. This is defense-in-depth for Google specifically: the
 * Gemini SDK sends the key in a header, not the request body, so it is not expected to come back
 * in an error message the way an OpenAI/Anthropic key sometimes does -- but redacting it here costs
 * nothing and covers the case if that ever changes.
 */
const MAX_MESSAGE_LENGTH = 300;
const API_KEY_PATTERN = /(sk-[A-Za-z0-9_*-]+|AIza[A-Za-z0-9_-]{10,})/g;

function sanitizeMessage(message: string): string {
  const redacted = message.replace(API_KEY_PATTERN, (m) => (m.startsWith("AIza") ? "AIza***" : "sk-***"));
  // Redact first, then truncate, so the redaction never has to reason about where the cut landed.
  // The ellipsis counts against the cap: the result is never longer than MAX_MESSAGE_LENGTH.
  return redacted.length > MAX_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : redacted;
}

export function toProviderError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const anyErr = err as { status?: number; code?: string; message?: string };
  const message = sanitizeMessage(anyErr?.message ?? String(err));
  const status = typeof anyErr?.status === "number" ? anyErr.status : undefined;
  let kind: ProviderErrorKind;
  if (status === 429) kind = "rate_limit";
  else if (status === 401 || status === 403) kind = "auth";
  else if (status !== undefined && status >= 500) kind = "transient";
  else if (status !== undefined) kind = "fatal";
  else if (anyErr?.code && TRANSIENT_CODES.has(anyErr.code)) kind = "transient";
  else kind = "fatal";
  return new ProviderError(kind, provider, message, { cause: err });
}
