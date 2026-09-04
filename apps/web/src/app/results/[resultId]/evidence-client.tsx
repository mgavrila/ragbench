"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import type { Attribution } from "@/lib/attribution";

type ChunkOffset = { id: string; idx: number; startOffset: number; endOffset: number };
type QuestionInfo = { question: string; goldAnswer: string; goldStart: number; goldEnd: number };
type DocumentInfo = { filename: string | null; text: string | null };

type Props = {
  resultId: string;
  runId: string;
  question: QuestionInfo;
  document: DocumentInfo;
  chunks: ChunkOffset[];
  initialAttribution: Attribution | null;
  initialResultStatus: string;
};

// Same palette as run-client's RUN_STATUS_COLOR/cellColor (green/amber/red/grey) -- per-file
// constants by house convention (plan 6 owns any future consolidation), not a shared module.
const GREEN = "#1a7f37";
const AMBER = "#9a6700";
const RED = "#cf222e";
const GREY = "#57606a";

// Mapping chosen for "is this fixable without touching the corpus": retrieval (raise k) is the
// closest thing to a quick fix, hence green; chunking and embedding both require rebuilding
// artifacts (amber/red per severity of what has to change); unanswerable is a likely test-set issue,
// not a pipeline failure, hence neutral grey.
const VERDICT_COLOR: Record<Attribution["verdict"], string> = {
  retrieval: GREEN,
  chunking: AMBER,
  embedding: RED,
  unanswerable: GREY,
};

const cellStyle: CSSProperties = { border: "1px solid #d0d7de", padding: "4px 8px", textAlign: "left" };

// ±2000 chars around the gold span, per brief -- long documents render a window instead of the
// whole text, with controls to grow it (and a shortcut to the full document).
const WINDOW_PAD = 2000;
const POLL_INTERVAL_MS = 2000;
// Bounded so a stuck poll re-enables Diagnose instead of spinning forever -- a diagnose that never
// completes is documented as "no row, ever" (silent failure, task-2-report.md); re-clicking is the
// only recovery path, so the UI must hand control back to the user rather than waiting indefinitely.
const POLL_TIMEOUT_MS = 30000;

type Segment = {
  start: number;
  text: string;
  isGold: boolean;
  isEvidence: boolean;
  boundaryChunkIdxs: number[] | null;
};

/**
 * Splits [windowStart, windowEnd) of `text` at every chunk-start offset and at the gold span's own
 * edges, so each resulting piece is either fully inside or fully outside the gold span. A chunk
 * boundary that falls INSIDE the gold span becomes its own breakpoint, which is what makes a
 * straddled span render as two separate <mark> pieces with the boundary's tick between them, rather
 * than one continuous highlight that hides the split.
 */
function buildSegments(
  text: string,
  windowStart: number,
  windowEnd: number,
  goldStart: number,
  goldEnd: number,
  chunkOffsets: ChunkOffset[],
  evidenceIds: Set<string>,
): Segment[] {
  const gs = Math.max(windowStart, Math.min(goldStart, windowEnd));
  const ge = Math.max(windowStart, Math.min(goldEnd, windowEnd));

  const chunkStartsInWindow = new Map<number, number[]>();
  for (const c of chunkOffsets) {
    if (c.startOffset > windowStart && c.startOffset < windowEnd) {
      const idxs = chunkStartsInWindow.get(c.startOffset) ?? [];
      idxs.push(c.idx);
      chunkStartsInWindow.set(c.startOffset, idxs);
    }
  }

  const points = [...new Set([windowStart, windowEnd, gs, ge, ...chunkStartsInWindow.keys()])].sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a >= b) continue; // two breakpoints coincided -- a zero-length segment, skip it
    const isGold = ge > gs && a >= gs && b <= ge;
    const isEvidence = chunkOffsets.some((c) => evidenceIds.has(c.id) && c.startOffset < b && c.endOffset > a);
    segments.push({
      start: a,
      text: text.slice(a, b),
      isGold,
      isEvidence,
      boundaryChunkIdxs: a === windowStart ? null : (chunkStartsInWindow.get(a) ?? null),
    });
  }
  return segments;
}

function MatrixTable({ matrix }: { matrix: Attribution["counterfactuals"]["matrix"] }) {
  if (matrix.length === 0) return <p>(no counterfactuals were run)</p>;
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={cellStyle}>Kind</th>
          <th style={cellStyle}>Label</th>
          <th style={cellStyle}>Hit</th>
          <th style={cellStyle}>Rank</th>
        </tr>
      </thead>
      <tbody>
        {matrix.map((c, i) => (
          <tr key={`${c.kind}-${c.label}-${i}`}>
            <td style={cellStyle}>{c.kind}</td>
            <td style={cellStyle}>{c.label}</td>
            <td style={{ ...cellStyle, color: c.hit ? GREEN : RED }}>{c.hit ? "✓" : "✗"}</td>
            <td style={cellStyle}>{c.rank ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EvidenceClient({
  resultId, runId, question, document, chunks, initialAttribution, initialResultStatus,
}: Props) {
  const [attribution, setAttribution] = useState<Attribution | null>(initialAttribution);
  const [posting, setPosting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);

  const mounted = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  async function diagnose() {
    setPosting(true);
    setDiagnoseError(null);
    setTimedOut(false);
    try {
      const res = await fetch(`/api/results/${resultId}/diagnose`, { method: "POST" });
      if (!mounted.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setPosting(false);
        setDiagnoseError(body.error ?? "failed to start diagnose");
        return;
      }
      setPosting(false);
      setPolling(true);
      elapsedRef.current = 0;
      timerRef.current = setInterval(async () => {
        elapsedRef.current += POLL_INTERVAL_MS;
        try {
          const pollRes = await fetch(`/api/results/${resultId}/attribution`);
          if (!mounted.current) return;
          if (pollRes.ok) {
            const body = await pollRes.json();
            if (body.attribution) {
              if (timerRef.current) clearInterval(timerRef.current);
              timerRef.current = null;
              setAttribution(body.attribution);
              setPolling(false);
              return;
            }
          }
        } catch {
          // A transient poll failure doesn't end the loop early -- the bounded timeout below still
          // applies, so a run of blips degrades to "try again" rather than a stuck spinner.
        }
        if (!mounted.current) return;
        if (elapsedRef.current >= POLL_TIMEOUT_MS) {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          setPolling(false);
          setTimedOut(true);
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      if (!mounted.current) return;
      setPosting(false);
      setDiagnoseError(err instanceof Error ? err.message : "failed to start diagnose");
    }
  }

  const text = document.text ?? "";
  const [windowEnd, setWindowEnd] = useState(() => Math.min(text.length, question.goldEnd + WINDOW_PAD));
  // Clamped to windowEnd: a gold span far beyond a re-parsed (now shorter) document would otherwise
  // put windowStart past windowEnd -- buildSegments degrades to an empty render on that inversion,
  // but an empty window with no highlight is worse than showing the document's tail.
  const [windowStart, setWindowStart] = useState(() =>
    Math.min(Math.max(0, question.goldStart - WINDOW_PAD), Math.min(text.length, question.goldEnd + WINDOW_PAD)),
  );

  const evidenceIds = new Set(attribution?.evidenceChunkIds ?? []);
  const segments = document.text !== null
    ? buildSegments(text, windowStart, windowEnd, question.goldStart, question.goldEnd, chunks, evidenceIds)
    : [];

  return (
    <div>
      <p><Link href={`/runs/${runId}`}>← Back to run</Link></p>
      <h1>{question.question}</h1>
      <p>Gold answer: {question.goldAnswer}</p>
      <p>Document: {document.filename ?? "(unknown)"}</p>

      <section>
        <h2>Diagnosis</h2>
        {attribution ? (
          <>
            <p>
              <span
                style={{
                  background: VERDICT_COLOR[attribution.verdict], color: "white",
                  padding: "2px 8px", borderRadius: 4, fontWeight: "bold",
                }}
              >
                {attribution.verdict}
              </span>{" "}
              <code>{attribution.counterfactuals.rule}</code>
            </p>
            <p>{attribution.explanation ?? "explanation unavailable"}</p>
            <h3>Counterfactual matrix</h3>
            <MatrixTable matrix={attribution.counterfactuals.matrix} />
            {attribution.counterfactuals.skipped.length > 0 ? (
              <>
                <h3>Skipped</h3>
                <ul>
                  {attribution.counterfactuals.skipped.map((s) => <li key={s}>{s}</li>)}
                </ul>
              </>
            ) : null}
          </>
        ) : (
          <div>
            <p>
              {initialResultStatus === "done" || initialResultStatus === "failed"
                ? "Not yet diagnosed."
                : "This result hasn't finished evaluating yet -- diagnosis works on any status, but there may be nothing conclusive yet."}
            </p>
            <button type="button" onClick={diagnose} disabled={posting || polling}>
              {posting ? "Starting…" : polling ? "Diagnosing…" : timedOut ? "Try again" : "Diagnose"}
            </button>
            {timedOut ? <p role="alert">Still not ready after 30s -- click Diagnose to check again.</p> : null}
            {diagnoseError ? <p role="alert">{diagnoseError}</p> : null}
          </div>
        )}
      </section>

      <section>
        <h2>Evidence</h2>
        {document.text === null ? (
          <p>Document text unavailable.</p>
        ) : (
          <>
            <p>
              {windowStart > 0 ? (
                <button type="button" onClick={() => setWindowStart((w) => Math.max(0, w - WINDOW_PAD))}>
                  Show {Math.min(WINDOW_PAD, windowStart)} more chars before
                </button>
              ) : null}{" "}
              {windowEnd < text.length ? (
                <button type="button" onClick={() => setWindowEnd((w) => Math.min(text.length, w + WINDOW_PAD))}>
                  Show {Math.min(WINDOW_PAD, text.length - windowEnd)} more chars after
                </button>
              ) : null}{" "}
              {windowStart > 0 || windowEnd < text.length ? (
                <button type="button" onClick={() => { setWindowStart(0); setWindowEnd(text.length); }}>
                  Show full document
                </button>
              ) : null}
            </p>
            <div style={{ border: "1px solid #d0d7de", padding: "8px 12px", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
              {windowStart > 0 ? "… " : null}
              {segments.map((seg) => {
                const style: CSSProperties = {};
                if (seg.boundaryChunkIdxs) {
                  style.borderLeft = `2px solid ${GREY}`;
                  style.paddingLeft = 2;
                  style.marginLeft = 1;
                }
                if (seg.isEvidence && !seg.isGold) style.background = "rgba(154,103,0,0.12)";
                const title = seg.boundaryChunkIdxs
                  ? `chunk ${seg.boundaryChunkIdxs.join(", ")} starts here`
                  : undefined;
                const content = seg.isGold ? <mark style={{ background: "#fff3b8" }}>{seg.text}</mark> : seg.text;
                return (
                  <span key={seg.start} style={style} title={title}>
                    {content}
                  </span>
                );
              })}
              {windowEnd < text.length ? " …" : null}
            </div>
            <p style={{ color: GREY, fontSize: "0.9em" }}>
              Vertical ticks mark where a chunk starts (hover for its index); the amber tint marks
              chunks the diagnosis used as evidence.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
