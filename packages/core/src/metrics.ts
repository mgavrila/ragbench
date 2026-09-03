export type Span = { start: number; end: number };

/** Half-open span overlap: [start, end). Touching spans (a.end === b.start) do not overlap. */
export function spansOverlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Scores a retrieval result against a single gold (documentId, span) pair: the first retrieved item
 * (0-based index i) whose documentId matches AND whose span overlaps the gold span is the hit, with
 * reciprocal rank 1/(i+1). No such item means no hit and reciprocal rank 0.
 */
export function evaluateRetrieval(
  retrieved: Array<{ documentId: string; span: Span }>,
  gold: { documentId: string; span: Span },
): { hit: boolean; reciprocalRank: number } {
  for (let i = 0; i < retrieved.length; i++) {
    const item = retrieved[i];
    if (item.documentId === gold.documentId && spansOverlap(item.span, gold.span)) {
      return { hit: true, reciprocalRank: 1 / (i + 1) };
    }
  }
  return { hit: false, reciprocalRank: 0 };
}
