const MIN_QUOTE_CHARS = 12;
const DEFAULT_PASSAGE_CHARS = 1200;

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

  function snapStart(pos: number): number {
    let p = Math.max(0, Math.min(pos, len));
    while (p > 0 && p < len && !/\s/.test(docText[p - 1]) && !/\s/.test(docText[p])) p--;
    while (p > 0 && /\s/.test(docText[p])) p++;
    return Math.min(p, len);
  }

  function snapEnd(pos: number): number {
    let p = Math.max(0, Math.min(pos, len));
    while (p < len && !/\s/.test(docText[p])) p++;
    return p;
  }

  const n = count;
  // Evenly spread `n` window start positions across the document.
  const span = Math.max(len - passageChars, 0);
  const out: Array<{ text: string; start: number; end: number }> = [];
  let prevEnd = 0;
  for (let i = 0; i < n; i++) {
    const target = n === 1 ? 0 : Math.round((span * i) / (n - 1));
    let start = snapStart(Math.max(target, prevEnd));
    let end = snapEnd(Math.min(start + passageChars, len));
    if (start >= end) {
      start = snapStart(prevEnd);
      end = snapEnd(Math.min(start + passageChars, len));
    }
    if (start >= end || start >= len) break;
    out.push({ text: docText.slice(start, end), start, end });
    prevEnd = end;
  }
  return out;
}

/** Extracts the first JSON array literal from raw text, tolerating code fences and prose around it. */
function extractFirstJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf("[");
  if (start === -1) return null;
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

export function parseQaJson(raw: string): Array<{ question: string; answer: string; quote: string }> {
  const arr = extractFirstJsonArray(raw);
  if (!arr) return [];
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
