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

export function toProviderError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const anyErr = err as { status?: number; code?: string; message?: string };
  const message = anyErr?.message ?? String(err);
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
