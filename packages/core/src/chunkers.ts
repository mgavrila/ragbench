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

export function chunkFixed(text: string, params: { maxTokens?: number; overlapTokens?: number }): Chunk[] {
  const maxTokens = params.maxTokens ?? 200;
  const overlap = Math.min(params.overlapTokens ?? 40, maxTokens - 1);
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

export function chunkHeading(text: string, params: { maxChars?: number }): Chunk[] {
  const maxChars = params.maxChars ?? 4000;
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
  params: { windowSentences?: number; overlapSentences?: number },
): Chunk[] {
  const win = params.windowSentences ?? 5;
  const overlap = Math.min(params.overlapSentences ?? 1, win - 1);
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
  fixed: (t, p) => chunkFixed(t, p as { maxTokens?: number; overlapTokens?: number }),
  heading: (t, p) => chunkHeading(t, p as { maxChars?: number }),
  "sentence-window": (t, p) => chunkSentenceWindow(t, p as { windowSentences?: number; overlapSentences?: number }),
};

export function hashParams(params: Record<string, unknown>): string {
  const stable = JSON.stringify(params, Object.keys(params).sort());
  return createHash("sha256").update(stable).digest("hex");
}
