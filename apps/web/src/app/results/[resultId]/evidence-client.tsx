"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import type { Attribution, StoredSignals } from "@/lib/attribution";
import { SectionHead } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { DataTable } from "@/components/data-table";
import { Notice } from "@/components/notice";
import { cls, cx, state, VERDICT_TONE } from "@/lib/ui";

type ChunkOffset = { id: string; idx: number; startOffset: number; endOffset: number };
type QuestionInfo = { question: string; goldAnswer: string; goldStart: number; goldEnd: number };
type DocumentInfo = { filename: string | null; text: string | null };

type Props = {
  resultId: string;
  runId: string;
  question: QuestionInfo;
  doc: DocumentInfo;
  chunks: ChunkOffset[];
  initialAttribution: Attribution | null;
  initialResultStatus: string;
  hit: boolean | null;
};

// ±2000 chars around the gold span, per brief -- long documents render a window instead of the
// whole text, with controls to grow it (and a shortcut to the full document).
const WINDOW_PAD = 2000;
const POLL_INTERVAL_MS = 2000;
// Bounded so a stuck poll re-enables Diagnose instead of spinning forever -- a diagnose that never
// completes is documented as "no row, ever" (silent failure, task-2-report.md); re-clicking is the
// only recovery path, so the UI must hand control back to the user rather than waiting indefinitely.
const POLL_TIMEOUT_MS = 30000;

/** The gold highlight, as references to the tokens `.rb-doc mark` is painted from -- the legend
 * swatch has to match the marks in the document exactly, and a copied hex would drift. */
const GOLD_FILL = "var(--rb-gold)";
const GOLD_LINE = "var(--rb-gold-line)";
/** The tint over chunks the diagnosis actually leaned on. Amber at 12% -- readable text over it. */
const EVIDENCE_TINT = "rgba(154,103,0,0.12)";

export type Segment = {
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
export function buildSegments(
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
  return (
    <DataTable
      isEmpty={matrix.length === 0}
      empty={<p className={cls.muted}>(no counterfactuals were run)</p>}
      head={
        <>
          <th>Kind</th>
          <th>Variant</th>
          <th>Hit</th>
          <th className={cls.num}>Rank</th>
        </>
      }
    >
      {matrix.map((c, i) => (
        <tr key={`${c.kind}-${c.label}-${i}`}>
          <td className={cls.muted}>{c.kind}</td>
          <td>{c.label}</td>
          <td style={{ color: c.hit ? state.success : state.danger, fontWeight: 600 }}>
            {c.hit ? "✓ hit" : "✗ miss"}
          </td>
          <td className={cls.num}>{c.rank ?? "—"}</td>
        </tr>
      ))}
    </DataTable>
  );
}

/**
 * The numbers the verdict was actually decided from. `bestGoldScore` is rendered only when the
 * stored row carries it: attributions written before the field existed have it undefined, and
 * printing 0.000 for "we do not know" would read as "the gold chunk scored nothing".
 */
function SignalsBlock({ signals }: { signals: StoredSignals }) {
  return (
    <dl className={cls.kv}>
      <dt>Gold span within one chunk</dt>
      <dd>{signals.goldInSingleChunk ? "yes" : "no"}</dd>
      <dt>Best gold chunk rank</dt>
      <dd>{signals.bestGoldRank ?? "— (no chunk overlaps gold)"}</dd>
      <dt>Top-k cutoff</dt>
      <dd>{signals.k}</dd>
      {typeof signals.bestGoldScore === "number" ? (
        <>
          <dt>Best gold similarity</dt>
          <dd>{signals.bestGoldScore.toFixed(3)}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function EvidenceClient({
  resultId, runId, question, doc, chunks, initialAttribution, initialResultStatus, hit,
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

  const text = doc.text ?? "";
  const [windowEnd, setWindowEnd] = useState(() => Math.min(text.length, question.goldEnd + WINDOW_PAD));
  // Clamped to windowEnd: a gold span far beyond a re-parsed (now shorter) document would otherwise
  // put windowStart past windowEnd -- buildSegments degrades to an empty render on that inversion,
  // but an empty window with no highlight is worse than showing the document's tail.
  const [windowStart, setWindowStart] = useState(() =>
    Math.min(Math.max(0, question.goldStart - WINDOW_PAD), Math.min(text.length, question.goldEnd + WINDOW_PAD)),
  );

  const evidenceIds = new Set(attribution?.evidenceChunkIds ?? []);
  const segments = doc.text !== null
    ? buildSegments(text, windowStart, windowEnd, question.goldStart, question.goldEnd, chunks, evidenceIds)
    : [];

  return (
    <div>
      <p style={{ marginBottom: 12 }}>
        <Link href={`/runs/${runId}`}>&larr; Back to run</Link>
      </p>

      <div className="rb-page-header">
        <div className="rb-page-header__body">
          <span className={cls.eyebrow}>Evidence</span>
          <h1>{question.question}</h1>
          <div className="rb-page-header__meta">
            Gold answer: <strong style={{ fontWeight: 600, color: "var(--rb-text)" }}>{question.goldAnswer}</strong>
            {" · "}
            <span className={cls.mono}>{doc.filename ?? "(unknown document)"}</span>
          </div>
        </div>
      </div>

      <section className={cls.section}>
        <SectionHead title="Diagnosis" />
        {attribution ? (
          <div className={cls.cardPad}>
            <div className={cls.row} style={{ marginBottom: 12 }}>
              <StatusBadge
                status={attribution.verdict}
                tone={VERDICT_TONE[attribution.verdict]}
                variant="solid"
              />
              <code className={cls.code}>{attribution.counterfactuals.rule}</code>
            </div>
            <p style={{ maxWidth: "70ch" }}>
              {attribution.explanation ?? <span className={cls.muted}>explanation unavailable</span>}
            </p>
            <div style={{ marginTop: 16 }}>
              <span className={cls.eyebrow}>Signals</span>
              <SignalsBlock signals={attribution.counterfactuals.signals} />
            </div>
          </div>
        ) : (
          <div className={cls.cardPad}>
            <p>
              {initialResultStatus === "done" || initialResultStatus === "failed"
                ? "Not yet diagnosed."
                : "This result hasn't finished evaluating yet -- diagnosis works on any status, but there may be nothing conclusive yet."}
            </p>
            {/* decideVerdict's precondition is a missed question; a hit row has nothing to diagnose,
                so the button (and its try-again/error state) is gated to hit === false. */}
            {hit === false ? (
              <>
                <button
                  type="button"
                  className={cls.btnPrimary}
                  style={{ marginTop: 12 }}
                  onClick={diagnose}
                  disabled={posting || polling}
                >
                  {posting ? "Starting…" : polling ? "Diagnosing…" : timedOut ? "Try again" : "Diagnose"}
                </button>
                {timedOut ? (
                  <Notice tone="warning">Still not ready after 30s -- click Diagnose to check again.</Notice>
                ) : null}
                {diagnoseError ? <Notice>{diagnoseError}</Notice> : null}
              </>
            ) : hit === true ? (
              <p className={cls.muted} style={{ marginTop: 8 }}>
                This result retrieved the gold chunk (a hit) -- diagnosis explains retrieval misses, not hits.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {attribution ? (
        <section className={cls.section}>
          <SectionHead
            title="Counterfactual matrix"
            hint="What the same question would have done under one changed variable."
          />
          <MatrixTable matrix={attribution.counterfactuals.matrix} />
          {attribution.counterfactuals.skipped.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <span className={cls.eyebrow}>Skipped</span>
              <ul className={cls.muted} style={{ paddingLeft: 20, fontSize: 13 }}>
                {attribution.counterfactuals.skipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className={cls.section}>
        <SectionHead
          title="Source document"
          hint={doc.text !== null ? `${text.length.toLocaleString()} characters` : undefined}
        />
        {doc.text === null ? (
          <p className={cls.muted}>Document text unavailable.</p>
        ) : (
          <>
            <div className={cls.doc}>
              {windowStart > 0 ? <span className={cls.muted}>… </span> : null}
              {segments.map((seg) => {
                const style: CSSProperties = {};
                if (seg.isEvidence && !seg.isGold) style.background = EVIDENCE_TINT;
                const title = seg.boundaryChunkIdxs
                  ? `chunk ${seg.boundaryChunkIdxs.join(", ")} starts here`
                  : undefined;
                const content = seg.isGold ? <mark>{seg.text}</mark> : seg.text;
                return (
                  <span
                    key={seg.start}
                    className={cx(seg.boundaryChunkIdxs && cls.tick)}
                    style={style}
                    title={title}
                  >
                    {content}
                  </span>
                );
              })}
              {windowEnd < text.length ? <span className={cls.muted}> …</span> : null}
            </div>

            <div className={cls.legend}>
              <span className={cls.legendItem}>
                <span className={cls.legendSwatch} style={{ background: GOLD_FILL, borderColor: GOLD_LINE }} />
                gold answer span
              </span>
              <span className={cls.legendItem}>
                <span
                  className={cls.legendSwatch}
                  style={{ background: "transparent", borderLeft: "3px solid var(--rb-text-muted)" }}
                />
                chunk boundary (hover for its index)
              </span>
              <span className={cls.legendItem}>
                <span className={cls.legendSwatch} style={{ background: EVIDENCE_TINT }} />
                chunk the diagnosis used as evidence
              </span>
            </div>

            {windowStart > 0 || windowEnd < text.length ? (
              <div className={cls.row} style={{ marginTop: 12 }}>
                {windowStart > 0 ? (
                  <button
                    type="button"
                    className={cls.btn}
                    onClick={() => setWindowStart((w) => Math.max(0, w - WINDOW_PAD))}
                  >
                    ↑ {Math.min(WINDOW_PAD, windowStart)} more chars before
                  </button>
                ) : null}
                {windowEnd < text.length ? (
                  <button
                    type="button"
                    className={cls.btn}
                    onClick={() => setWindowEnd((w) => Math.min(text.length, w + WINDOW_PAD))}
                  >
                    ↓ {Math.min(WINDOW_PAD, text.length - windowEnd)} more chars after
                  </button>
                ) : null}
                <button
                  type="button"
                  className={cls.btnGhost}
                  onClick={() => { setWindowStart(0); setWindowEnd(text.length); }}
                >
                  Show full document
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
