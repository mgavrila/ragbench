import { describe, it, expect } from "vitest";
import { buildSegments, type Segment } from "@/app/results/[resultId]/evidence-client";

// Fixed ~60-char text with a 3-chunk layout: [0,20) [20,40) [40,60) -- boundaries at 20 and 40.
// "The quick brown fox jumps over the lazy dog near the bank."
//  0         1         2         3         4         5
//  0123456789012345678901234567890123456789012345678901234567
const TEXT = "The quick brown fox jumps over the lazy dog near the bank.";
const CHUNKS = [
  { id: "c0", idx: 0, startOffset: 0, endOffset: 20 },
  { id: "c1", idx: 1, startOffset: 20, endOffset: 40 },
  { id: "c2", idx: 2, startOffset: 40, endOffset: 60 },
];
const NO_EVIDENCE = new Set<string>();

function gold(segments: Segment[]): Segment[] {
  return segments.filter((s) => s.isGold);
}

describe("buildSegments", () => {
  it("splits a straddling span into two mark segments, with the boundary tick on the second", () => {
    // Span [15,25) crosses the chunk-1 boundary at 20.
    const segments = buildSegments(TEXT, 0, 60, 15, 25, CHUNKS, NO_EVIDENCE);
    expect(segments).toEqual([
      { start: 0, text: TEXT.slice(0, 15), isGold: false, isEvidence: false, boundaryChunkIdxs: null },
      { start: 15, text: TEXT.slice(15, 20), isGold: true, isEvidence: false, boundaryChunkIdxs: null },
      { start: 20, text: TEXT.slice(20, 25), isGold: true, isEvidence: false, boundaryChunkIdxs: [1] },
      { start: 25, text: TEXT.slice(25, 40), isGold: false, isEvidence: false, boundaryChunkIdxs: null },
      { start: 40, text: TEXT.slice(40, 60), isGold: false, isEvidence: false, boundaryChunkIdxs: [2] },
    ]);
    expect(gold(segments)).toHaveLength(2);
  });

  it("keeps a span fully inside one chunk as a single mark with no tick inside it", () => {
    // Span [25,35) sits entirely inside chunk 1 [20,40).
    const segments = buildSegments(TEXT, 0, 60, 25, 35, CHUNKS, NO_EVIDENCE);
    const goldSegments = gold(segments);
    expect(goldSegments).toEqual([
      { start: 25, text: TEXT.slice(25, 35), isGold: true, isEvidence: false, boundaryChunkIdxs: null },
    ]);
    // The chunk-1 boundary at 20 is on the preceding non-gold segment, not inside the mark.
    expect(segments).toContainEqual({
      start: 20, text: TEXT.slice(20, 25), isGold: false, isEvidence: false, boundaryChunkIdxs: [1],
    });
  });

  it("does not spuriously split when a chunk start coincides with goldStart", () => {
    // Span [20,30) starts exactly where chunk 1 starts -- the tick lands on the gold segment itself,
    // not as a separate zero-length segment before it.
    const segments = buildSegments(TEXT, 0, 60, 20, 30, CHUNKS, NO_EVIDENCE);
    expect(segments).toEqual([
      { start: 0, text: TEXT.slice(0, 20), isGold: false, isEvidence: false, boundaryChunkIdxs: null },
      { start: 20, text: TEXT.slice(20, 30), isGold: true, isEvidence: false, boundaryChunkIdxs: [1] },
      { start: 30, text: TEXT.slice(30, 40), isGold: false, isEvidence: false, boundaryChunkIdxs: null },
      { start: 40, text: TEXT.slice(40, 60), isGold: false, isEvidence: false, boundaryChunkIdxs: [2] },
    ]);
  });

  it("does not spuriously split when a chunk start coincides with goldEnd", () => {
    // Span [10,20) ends exactly where chunk 1 starts -- the tick lands on the following non-gold
    // segment, with no empty segment wedged in between.
    const segments = buildSegments(TEXT, 0, 60, 10, 20, CHUNKS, NO_EVIDENCE);
    expect(segments).toEqual([
      { start: 0, text: TEXT.slice(0, 10), isGold: false, isEvidence: false, boundaryChunkIdxs: null },
      { start: 10, text: TEXT.slice(10, 20), isGold: true, isEvidence: false, boundaryChunkIdxs: null },
      { start: 20, text: TEXT.slice(20, 40), isGold: false, isEvidence: false, boundaryChunkIdxs: [1] },
      { start: 40, text: TEXT.slice(40, 60), isGold: false, isEvidence: false, boundaryChunkIdxs: [2] },
    ]);
  });

  it("clamps a gold span extending past both window edges, with no tick on the first segment", () => {
    // Window is [15,45); gold [0,60) covers the whole document, so it's clamped to the window and
    // the entire visible text renders gold -- the leading edge never gets a boundary tick, even
    // though nothing chunk-related is special about offset 15.
    const segments = buildSegments(TEXT, 15, 45, 0, 60, CHUNKS, NO_EVIDENCE);
    expect(segments).toEqual([
      { start: 15, text: TEXT.slice(15, 20), isGold: true, isEvidence: false, boundaryChunkIdxs: null },
      { start: 20, text: TEXT.slice(20, 40), isGold: true, isEvidence: false, boundaryChunkIdxs: [1] },
      { start: 40, text: TEXT.slice(40, 45), isGold: true, isEvidence: false, boundaryChunkIdxs: [2] },
    ]);
  });

  it("clamps goldEnd past the text length without crashing", () => {
    const segments = buildSegments(TEXT, 0, 60, 55, 1000, CHUNKS, NO_EVIDENCE);
    expect(segments).toEqual([
      { start: 0, text: TEXT.slice(0, 20), isGold: false, isEvidence: false, boundaryChunkIdxs: null },
      { start: 20, text: TEXT.slice(20, 40), isGold: false, isEvidence: false, boundaryChunkIdxs: [1] },
      { start: 40, text: TEXT.slice(40, 55), isGold: false, isEvidence: false, boundaryChunkIdxs: [2] },
      { start: 55, text: TEXT.slice(55, 60), isGold: true, isEvidence: false, boundaryChunkIdxs: null },
    ]);
  });

  // The evidence highlight is per chunk, not per gold span: a segment is evidence when any chunk
  // the diagnosis named overlaps it. Every other case in this file passes an empty evidence set, so
  // this is the one that pins what a non-empty one does -- including that the flag follows the
  // chunk's own extent across the gold boundary rather than stopping at the mark.
  it("marks segments overlapping an evidence chunk, independently of the gold span", () => {
    // Chunk 1 [20,40) is evidence; the gold span [25,35) sits inside it, so the mark splits the
    // chunk into three segments and all three are evidence. Chunks 0 and 2 are not.
    const segments = buildSegments(TEXT, 0, 60, 25, 35, CHUNKS, new Set(["c1"]));
    expect(segments).toEqual([
      { start: 0, text: TEXT.slice(0, 20), isGold: false, isEvidence: false, boundaryChunkIdxs: null },
      { start: 20, text: TEXT.slice(20, 25), isGold: false, isEvidence: true, boundaryChunkIdxs: [1] },
      { start: 25, text: TEXT.slice(25, 35), isGold: true, isEvidence: true, boundaryChunkIdxs: null },
      { start: 35, text: TEXT.slice(35, 40), isGold: false, isEvidence: true, boundaryChunkIdxs: null },
      { start: 40, text: TEXT.slice(40, 60), isGold: false, isEvidence: false, boundaryChunkIdxs: [2] },
    ]);
  });

  it("returns no segments for an empty text without crashing", () => {
    const segments = buildSegments("", 0, 0, 5, 10, CHUNKS, NO_EVIDENCE);
    expect(segments).toEqual([]);
  });
});
