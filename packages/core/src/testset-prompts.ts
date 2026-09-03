const MIN_SENTENCE_CHARS = 30;

export function buildGenerationPrompt(passage: string, n: number): string {
  return [
    `You are generating a test set of extractive question-answer pairs from a single passage.`,
    ``,
    `Passage:`,
    `"""`,
    passage,
    `"""`,
    ``,
    `Generate exactly ${n} question-answer pairs from the passage above. For each pair:`,
    `- "quote" must be copied VERBATIM from the passage (an exact substring, not paraphrased).`,
    `- "answer" must be contained within the quote.`,
    `- "question" must read as a natural question a person would ask; do not quote rare or`,
    `  distinctive phrasing from the passage verbatim inside the question itself.`,
    ``,
    `Respond with ONLY a JSON array of exactly ${n} objects, each shaped like:`,
    `[{"question": "...", "answer": "...", "quote": "..."}]`,
    `Do not include any text before or after the JSON array.`,
  ].join("\n");
}

export function buildTrivialityGatePrompt(question: string, quote: string): string {
  return [
    `Question: "${question}"`,
    `Quote: "${quote}"`,
    ``,
    `Determine whether this question is TRIVIAL: a question is trivial when it contains a`,
    `distinctive verbatim phrase from the quote, making the question answerable by simple`,
    `string-matching against the quote rather than genuine understanding.`,
    ``,
    `Respond with ONLY strict JSON of the form {"trivial": true} or {"trivial": false}.`,
    `Do not include any other text.`,
  ].join("\n");
}

/** Extracts the {"trivial": boolean} value from raw text, tolerating fences and prose. Fails open (null) on any parse issue. */
export function parseGateJson(raw: string): boolean | null {
  const match = raw.match(/\{[^{}]*"trivial"\s*:\s*(true|false)[^{}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (parsed !== null && typeof parsed === "object" && "trivial" in parsed) {
      const value = (parsed as Record<string, unknown>).trivial;
      if (typeof value === "boolean") return value;
    }
  } catch {
    return null;
  }
  return null;
}

type Span = { start: number; end: number };

/** Sentence-splitting regex, reused from chunkers.ts's chunkSentenceWindow. */
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

/**
 * Deterministic demo-mode Q&A generator: no LLM call, no randomness. Splits the passage into
 * sentences, keeps the first `n` sentences of at least 30 chars, and derives each Q&A pair
 * mechanically from the sentence text so results are fully reproducible.
 *
 * A passage that starts inside the document is cut at a word boundary, not a sentence one, so its
 * first span is the tail of a sentence that began before the window ("quantity reached level 161
 * during the trial period."). That tail is dropped: long enough tails clear the 30-char floor and
 * would otherwise ship a mid-sentence fragment as the demo's gold answer. Dropping it also costs a
 * genuine sentence on the rare passage that happens to start on a sentence boundary -- the passage
 * still has the rest of its sentences to offer, so the cheap check wins over tracking boundaries.
 */
export function mockGenerateQa(
  passage: { text: string; start: number },
  n: number,
): Array<{ question: string; answer: string; quote: string }> {
  const allSpans = sentenceSpans(passage.text);
  const spans = passage.start > 0 ? allSpans.slice(1) : allSpans;
  const out: Array<{ question: string; answer: string; quote: string }> = [];
  for (const span of spans) {
    if (out.length >= n) break;
    const sentence = passage.text.slice(span.start, span.end).trim();
    if (sentence.length < MIN_SENTENCE_CHARS) continue;
    const firstFiveWords = sentence.split(/\s+/).slice(0, 5).join(" ");
    out.push({
      question: `What does the document state about ${firstFiveWords}?`,
      answer: sentence,
      quote: sentence,
    });
  }
  return out;
}
