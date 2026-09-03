import { createHash } from "node:crypto";

export type Chunk = { text: string; startOffset: number; endOffset: number };

type Span = { start: number; end: number };

function tokenSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length });
  return spans;
}

function slice(text: string, start: number, end: number): Chunk {
  return { text: text.slice(start, end), startOffset: start, endOffset: end };
}

// Params reach these functions from user-supplied JSON. A window size of 0 or a negative overlap
// would make the loops below never advance (or advance backwards), so every size is normalized to
// a usable integer here rather than trusting the caller: fractions floor, and non-numbers or
// anything under `min` fall back to the default rather than being clamped up to `min` -- clamping
// a maxChars:0 up to 1 used to flood the output with thousands of 1-char chunks instead of the
// sane default-sized ones a caller almost certainly wanted.
function size(value: unknown, fallback: number, min: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Overlap must leave the window at least one unit of forward progress per step. */
function overlapSize(value: unknown, fallback: number, window: number): number {
  return Math.min(size(value, fallback, 0), window - 1);
}

export function chunkFixed(text: string, params: { maxTokens?: unknown; overlapTokens?: unknown }): Chunk[] {
  const maxTokens = size(params.maxTokens, 200, 1);
  const overlap = overlapSize(params.overlapTokens, 40, maxTokens);
  const spans = tokenSpans(text);
  if (spans.length === 0) return [];
  const out: Chunk[] = [];
  let i = 0;
  while (i < spans.length) {
    const last = Math.min(i + maxTokens, spans.length);
    out.push(slice(text, spans[i].start, spans[last - 1].end));
    if (last === spans.length) break;
    i = last - overlap;
  }
  return out;
}

export function chunkHeading(text: string, params: { maxChars?: unknown }): Chunk[] {
  const maxChars = size(params.maxChars, 4000, 1);
  if (text.trim().length === 0) return [];
  const starts = [0];
  const re = /^#{1,6} /gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (m.index !== 0) starts.push(m.index);
  const out: Chunk[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : text.length;
    for (let p = start; p < end; p += maxChars) {
      const c = slice(text, p, Math.min(p + maxChars, end));
      if (c.text.trim().length > 0) out.push(c);
    }
  }
  return out;
}

function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /[^.!?]*[.!?]+(?=\s|$)|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].trim().length > 0) spans.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return spans;
}

export function chunkSentenceWindow(
  text: string,
  params: { windowSentences?: unknown; overlapSentences?: unknown },
): Chunk[] {
  const win = size(params.windowSentences, 5, 1);
  const overlap = overlapSize(params.overlapSentences, 1, win);
  const spans = sentenceSpans(text);
  if (spans.length === 0) return [];
  const out: Chunk[] = [];
  let i = 0;
  while (i < spans.length) {
    const last = Math.min(i + win, spans.length);
    out.push(slice(text, spans[i].start, spans[last - 1].end));
    if (last === spans.length) break;
    i = last - overlap;
  }
  return out;
}

export const CHUNKERS: Record<string, (text: string, params: Record<string, unknown>) => Chunk[]> = {
  fixed: (t, p) => chunkFixed(t, p),
  heading: (t, p) => chunkHeading(t, p),
  "sentence-window": (t, p) => chunkSentenceWindow(t, p),
};

/** JSON with object keys sorted at every depth, so equal params hash equally whatever their key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

export function hashParams(params: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(params)).digest("hex");
}
