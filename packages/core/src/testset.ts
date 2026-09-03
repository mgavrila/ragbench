const MIN_QUOTE_CHARS = 12;
// How far past (or before) a window edge the snapping below will look for a word boundary before
// giving up and cutting mid-word. The scan is bounded rather than "walk until whitespace" because
// text with no whitespace at all -- CJK prose, a minified JSON dump -- has no boundary to find, and
// an unbounded scan swallows the entire document into a single passage: the pre-flight cost
// estimate (which assumes ~passageChars per question) is then wrong by the document's length, and
// the demo generator ships the whole document as one gold answer.
const SNAP_SLACK_RATIO = 0.25;
// Exported so callers estimating generation cost ahead of a run (no documents chunked yet) can
// size their per-question token guess off the same window samplePassages actually cuts.
export const DEFAULT_PASSAGE_CHARS = 1200;

/** Collapse all whitespace runs to a single space and trim the ends. */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Builds a normalized (single-space-separated) rendering of `text` alongside a parallel index
 * mapping each character of the normalized string back to its position in the original text.
 */
function buildNormalizedIndex(text: string): { normalized: string; positions: number[] } {
  let normalized = "";
  const positions: number[] = [];
  let inWhitespace = true; // start true so leading whitespace is skipped, matching normalizeWs's trim
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inWhitespace && normalized.length > 0) {
        normalized += " ";
        positions.push(i);
      }
      inWhitespace = true;
    } else {
      normalized += ch;
      positions.push(i);
      inWhitespace = false;
    }
  }
  // Trailing whitespace never gets appended above, so `normalized` is already right-trimmed.
  return { normalized, positions };
}

export function verifyQuote(docText: string, quote: string): { start: number; end: number } | null {
  const normalizedQuote = normalizeWs(quote);
  if (normalizedQuote.length < MIN_QUOTE_CHARS) return null;

  const { normalized, positions } = buildNormalizedIndex(docText);
  const idx = normalized.indexOf(normalizedQuote);
  if (idx === -1) return null;

  const firstPos = positions[idx];
  const lastPos = positions[idx + normalizedQuote.length - 1];
  return { start: firstPos, end: lastPos + 1 };
}

export function samplePassages(
  docText: string,
  count: number,
  passageChars: number = DEFAULT_PASSAGE_CHARS,
): Array<{ text: string; start: number; end: number }> {
  if (count <= 0) return [];

  const len = docText.length;
  if (len === 0) return [];

  // Whole doc as one passage when it's short enough to fit within a single passage window.
  if (len <= passageChars) {
    return [{ text: docText, start: 0, end: len }];
  }

  const slack = Math.max(1, Math.ceil(passageChars * SNAP_SLACK_RATIO));

  // `floor` is the previous passage's end: backing up to a word boundary must never cross it, or
  // the windows overlap (and on whitespace-free text every window would back up to 0 and the same
  // passage would be emitted `count` times).
  function snapStart(pos: number, floor: number): number {
    let p = Math.max(0, Math.min(pos, len));
    const lowest = Math.max(floor, p - slack);
    while (p > lowest && p < len && !/\s/.test(docText[p - 1]) && !/\s/.test(docText[p])) p--;
    while (p > 0 && p < len && /\s/.test(docText[p])) p++;
    return Math.min(p, len);
  }

  function snapEnd(pos: number): number {
    const p = Math.max(0, Math.min(pos, len));
    const highest = Math.min(len, p + slack);
    let q = p;
    while (q < highest && !/\s/.test(docText[q])) q++;
    // No boundary within the slack: cut at the requested position rather than scanning on, so the
    // passage stays ~passageChars regardless of how the text is (or isn't) spaced.
    return q < highest || q === len ? q : p;
  }

  const n = count;
  // Evenly spread `n` window start positions across the document.
  const span = Math.max(len - passageChars, 0);
  const out: Array<{ text: string; start: number; end: number }> = [];
  let prevEnd = 0;
  for (let i = 0; i < n; i++) {
    const target = n === 1 ? 0 : Math.round((span * i) / (n - 1));
    let start = snapStart(Math.max(target, prevEnd), prevEnd);
    let end = snapEnd(Math.min(start + passageChars, len));
    if (start >= end) {
      start = snapStart(prevEnd, prevEnd);
      end = snapEnd(Math.min(start + passageChars, len));
    }
    if (start >= end || start >= len) break;
    out.push({ text: docText.slice(start, end), start, end });
    prevEnd = end;
  }
  return out;
}

/** Parses the balanced `[...]` array starting exactly at `start` in raw text, or null if unbalanced/invalid JSON. */
function matchJsonArrayAt(raw: string, start: number): unknown[] | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function filterQaEntries(arr: unknown[]): Array<{ question: string; answer: string; quote: string }> {
  const out: Array<{ question: string; answer: string; quote: string }> = [];
  for (const entry of arr) {
    if (entry === null || typeof entry !== "object") continue;
    const { question, answer, quote } = entry as Record<string, unknown>;
    if (typeof question === "string" && typeof answer === "string" && typeof quote === "string") {
      out.push({ question, answer, quote });
    }
  }
  return out;
}

/**
 * Extracts a QA array from raw LLM output, tolerating code fences and surrounding prose. Tries
 * every `[` in order as a candidate array start (an incidental bracket earlier in the prose, e.g.
 * `data[0]`, parses as valid but unrelated JSON) and accepts the first candidate that yields at
 * least one entry with all three required string fields, rather than stopping at whichever `[`
 * comes first in the text.
 */
export function parseQaJson(raw: string): Array<{ question: string; answer: string; quote: string }> {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "[") continue;
    const arr = matchJsonArrayAt(raw, i);
    if (!arr) continue;
    const filtered = filterQaEntries(arr);
    if (filtered.length > 0) return filtered;
  }
  return [];
}
