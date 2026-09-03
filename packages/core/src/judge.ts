import { normalizeWs } from "./testset";

const REFUSAL = "I cannot answer from the provided context";

export type JudgeResult = { faithfulness: number; correctness: number; reason: string };

export function buildAnswerPrompt(question: string, chunks: string[]): string {
  return [
    `Answer the question using ONLY the excerpts below. Do not use any outside knowledge.`,
    `If the excerpts do not contain the answer, respond exactly with "${REFUSAL}".`,
    ``,
    `Excerpts:`,
    ...chunks.map((c, i) => `[${i + 1}] """${c}"""`),
    ``,
    `Question: ${question}`,
    ``,
    `Answer:`,
  ].join("\n");
}

export function buildJudgePrompt(
  question: string,
  goldAnswer: string,
  answer: string,
  chunks: string[],
): string {
  return [
    `You are grading an AI-generated answer against a gold answer, using the source excerpts as context.`,
    ``,
    `Question: ${question}`,
    `Gold answer: ${goldAnswer}`,
    `AI answer: ${answer}`,
    ``,
    `Excerpts:`,
    ...chunks.map((c, i) => `[${i + 1}] """${c}"""`),
    ``,
    `Score two dimensions from 0 to 1:`,
    `- "faithfulness": does the AI answer rely only on the excerpts, without unsupported claims?`,
    `- "correctness": does the AI answer convey the same meaning as the gold answer?`,
    ``,
    `Respond with ONLY strict JSON of the form {"faithfulness": 0..1, "correctness": 0..1, "reason": "..."}.`,
    `Do not include any other text.`,
  ].join("\n");
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Parses the balanced `{...}` object starting exactly at `start` in raw text, or null if unbalanced/invalid JSON. */
function matchJsonObjectAt(raw: string, start: number): Record<string, unknown> | null {
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
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate) as unknown;
          return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Extracts the judge's {faithfulness, correctness, reason} from raw text, tolerating fences and prose. Fails open (null) on any parse issue or out-of-shape data; in-range scores are clamped to [0, 1]. */
export function parseJudgeJson(raw: string): JudgeResult | null {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    const obj = matchJsonObjectAt(raw, i);
    if (!obj) continue;
    const { faithfulness, correctness, reason } = obj;
    // Number.isFinite is defensive, not load-bearing: JSON grammar has no literal for NaN/Infinity,
    // so JSON.parse above would already have thrown on such input. Kept in case that ever changes.
    if (
      typeof faithfulness === "number" &&
      Number.isFinite(faithfulness) &&
      typeof correctness === "number" &&
      Number.isFinite(correctness) &&
      typeof reason === "string"
    ) {
      return { faithfulness: clamp01(faithfulness), correctness: clamp01(correctness), reason };
    }
  }
  return null;
}

/** Sentence-splitting regex, reused from testset-prompts.ts's sentenceSpans/mockGenerateQa. */
function firstSentence(text: string): string {
  const match = text.match(/[^.!?]*[.!?]+(?=\s|$)|[^.!?]+$/);
  return match ? match[0].trim() : text.trim();
}

/**
 * Deterministic demo-mode answerer: no LLM call, no randomness. Answers with the first chunk's
 * first sentence (whole chunk if no sentence boundary is found), or the fixed refusal string when
 * there are no chunks to answer from.
 */
export function mockAnswer(question: string, chunks: string[]): string {
  if (chunks.length === 0) return REFUSAL;
  return `Based on the context: ${firstSentence(chunks[0])}`;
}

/**
 * Deterministic demo-mode judge: no LLM call, no randomness. Scores correctness 1 iff the
 * normalized answer contains the gold answer's first five (normalized) words; faithfulness mirrors
 * correctness, since the mock has no independent way to check groundedness in the retrieved chunks.
 */
export function mockJudge(goldAnswer: string, answer: string): JudgeResult {
  const firstFiveWords = normalizeWs(goldAnswer).split(" ").slice(0, 5).join(" ");
  const score = firstFiveWords.length > 0 && normalizeWs(answer).includes(firstFiveWords) ? 1 : 0;
  return {
    faithfulness: score,
    correctness: score,
    reason: "mock judge: deterministic keyword match against the gold answer, no LLM call",
  };
}
