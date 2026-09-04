"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import type { Attribution } from "@/lib/attribution";

type RunDetail = {
  id: string;
  projectId: string;
  testSetId: string;
  mode: string;
  judgeModel: string | null;
  answerModel: string | null;
  status: string;
  error: string | null;
  totalJobs: number;
  completedJobs: number;
  createdAt: string;
};

type ConfigSummary = {
  config: { id: string; name: string; chunkSetId: string; embeddingModel: string; topK: number; createdAt: string };
  aggregates: {
    questions: number;
    evaluated: number;
    failed: number;
    hitRate: number | null;
    mrr: number | null;
    avgFaithfulness: number | null;
    avgCorrectness: number | null;
  };
};

type GridCell = { hit: boolean | null; reciprocalRank: number | null; status: string };
type GridRow = { questionId: string; question: string; perConfig: Record<string, GridCell> };

type RunResponse = { run: RunDetail; configs: ConfigSummary[]; grid: GridRow[] };

type RetrievedChunk = { chunkId: string; rank: number; score: number; text: string | null; filename: string | null };

type CellDetail = {
  result: {
    id: string;
    runId: string;
    configId: string;
    questionId: string;
    retrieved: RetrievedChunk[];
    hit: boolean | null;
    reciprocalRank: number | null;
    answer: string | null;
    faithfulness: number | null;
    correctness: number | null;
    judgeRaw: { raw: string } | null;
    status: string;
    error: string | null;
  };
  question: { id: string; question: string; goldAnswer: string; goldStart: number; goldEnd: number };
};

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

// Same palette as corpus-client/test-sets-client's STATUS_COLOR (green/amber/red/grey), reused here
// for run status and for grid cells so both sections read as one system.
const RUN_STATUS_COLOR: Record<string, string> = {
  pending: "#57606a",
  running: "#9a6700",
  done: "#1a7f37",
  failed: "#cf222e",
  cancelled: "#57606a",
};
const GREEN = "#1a7f37";
const RED = "#cf222e";
const AMBER = "#9a6700";
const GREY = "#57606a";

// Same verdict->color mapping as evidence-client.tsx (per-file constants by house convention, not a
// shared module -- see plan 6 for any future consolidation): retrieval (raise k) is closest to a
// quick fix, hence green; chunking/embedding both need rebuilding artifacts; unanswerable reads as
// a likely test-set issue rather than a pipeline failure, hence neutral grey.
const VERDICT_COLOR: Record<Attribution["verdict"], string> = {
  retrieval: GREEN, chunking: AMBER, embedding: RED, unanswerable: GREY,
};

type AttrState = {
  attribution: Attribution | null;
  posting: boolean;
  polling: boolean;
  timedOut: boolean;
  error: string | null;
};

const DEFAULT_ATTR_STATE: AttrState = { attribution: null, posting: false, polling: false, timedOut: false, error: null };

const POLL_INTERVAL_MS = 2000;
// Bounded so a diagnose that never resolves (silent-failure ruling: a non-retryable embed failure
// writes no row at all, task-2-report.md) re-enables the button instead of spinning forever.
const POLL_TIMEOUT_MS = 30000;

const cellStyle: CSSProperties = { border: "1px solid #d0d7de", padding: "4px 8px", textAlign: "left" };

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number | null, digits = 2): string {
  return v === null ? "—" : v.toFixed(digits);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** A `failed` cell can still carry a real hit/rr (retrieval succeeded, answer/judge failed): amber,
 * but with the hit/miss word still shown rather than hidden behind "failed". */
function cellColor(cell: GridCell): string {
  if (cell.status === "failed") return AMBER;
  if (cell.hit === true) return GREEN;
  if (cell.hit === false) return RED;
  return GREY;
}

function cellText(cell: GridCell): string {
  const base = cell.hit === true ? "hit" : cell.hit === false ? "miss" : cell.status;
  return cell.status === "failed" && cell.hit !== null ? `${base} (failed)` : base;
}

/** Reciprocal rank -> the 1-based rank it was computed from, for display. Null when there's no
 * rank to show (rr null or non-positive -- neither should occur on a hit, but stay total). */
function rankFromRR(rr: number | null): number | null {
  return rr !== null && rr > 0 ? Math.round(1 / rr) : null;
}

function judgeReason(judgeRaw: { raw: string } | null): string | null {
  if (!judgeRaw) return null;
  try {
    const parsed: unknown = JSON.parse(judgeRaw.raw);
    if (parsed && typeof parsed === "object" && "reason" in parsed && typeof parsed.reason === "string") {
      return parsed.reason;
    }
  } catch {
    // raw wasn't JSON (e.g. the model's response couldn't be parsed) -- fall through to showing it verbatim.
  }
  return judgeRaw.raw;
}

const cellButtonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  border: "none",
  color: "white",
  padding: "4px 8px",
  textAlign: "left",
  font: "inherit",
  cursor: "pointer",
};

export function RunClient({ runId }: { runId: string }) {
  const [data, setData] = useState<RunResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<{ configId: string; questionId: string } | null>(null);
  const [cellCache, setCellCache] = useState<Record<string, CellDetail>>({});
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  // openCell runs outside this effect, so it cannot use the `cancelled` flag below to decide
  // whether its awaited fetch still has a component to update. This is that flag for the drawer.
  const mounted = useRef(true);
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const pollElapsed = useRef<Record<string, number>>({});
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const t of Object.values(pollTimers.current)) clearInterval(t);
    };
  }, []);

  const [attrByResult, setAttrByResult] = useState<Record<string, AttrState>>({});

  function patchAttr(resultId: string, patch: Partial<AttrState>) {
    if (!mounted.current) return;
    setAttrByResult((prev) => ({
      ...prev,
      [resultId]: { ...DEFAULT_ATTR_STATE, ...prev[resultId], ...patch },
    }));
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function fetchOnce() {
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (cancelled) return;
        if (res.ok) {
          const body: RunResponse = await res.json();
          setData(body);
          // Cleared on every success: a single failed poll (the dev server restarting, a blip)
          // would otherwise leave the error latched forever while fresh data kept arriving.
          setLoadError(null);
          if (timer && TERMINAL_STATUSES.has(body.run.status)) {
            clearInterval(timer);
            timer = null;
          }
        } else {
          const body = await res.json().catch(() => ({}));
          setLoadError(body.error ?? "failed to load run");
        }
      } catch (err) {
        // fetch rejects on a network fault rather than resolving with !res.ok. Unhandled, that
        // rejection kills the poll silently and the page freezes on stale data with no explanation.
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "failed to load run");
      }
    }

    fetchOnce();
    timer = setInterval(fetchOnce, 2000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  function cellKey(configId: string, questionId: string): string {
    return `${configId}:${questionId}`;
  }

  // Courtesy check: when a drawer opens on a cell it hasn't seen before, look up whether it was
  // already diagnosed (e.g. in an earlier visit, or by another tab) so the badge appears without
  // requiring a fresh Diagnose click. Deliberately excludes attrByResult from its deps -- it only
  // needs to run once per newly-opened cell, not every time diagnose()'s own updates land.
  useEffect(() => {
    if (!selected) return;
    const detail = cellCache[cellKey(selected.configId, selected.questionId)];
    if (!detail) return;
    const resultId = detail.result.id;
    if (attrByResult[resultId] !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/results/${resultId}/attribution`);
        if (cancelled || !mounted.current || !res.ok) return;
        const body = await res.json();
        patchAttr(resultId, { attribution: body.attribution });
      } catch {
        // Best-effort only -- Diagnose stays the recovery path either way.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, cellCache]);

  async function diagnose(resultId: string) {
    patchAttr(resultId, { posting: true, error: null, timedOut: false });
    try {
      const res = await fetch(`/api/results/${resultId}/diagnose`, { method: "POST" });
      if (!mounted.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        patchAttr(resultId, { posting: false, error: body.error ?? "failed to start diagnose" });
        return;
      }
      patchAttr(resultId, { posting: false, polling: true });
      pollElapsed.current[resultId] = 0;
      pollTimers.current[resultId] = setInterval(async () => {
        pollElapsed.current[resultId] = (pollElapsed.current[resultId] ?? 0) + POLL_INTERVAL_MS;
        try {
          const pollRes = await fetch(`/api/results/${resultId}/attribution`);
          if (!mounted.current) return;
          if (pollRes.ok) {
            const body = await pollRes.json();
            if (body.attribution) {
              clearInterval(pollTimers.current[resultId]);
              delete pollTimers.current[resultId];
              patchAttr(resultId, { attribution: body.attribution, polling: false });
              return;
            }
          }
        } catch {
          // A single blip doesn't end the loop -- the bounded timeout below still applies.
        }
        if (!mounted.current) return;
        if ((pollElapsed.current[resultId] ?? 0) >= POLL_TIMEOUT_MS) {
          clearInterval(pollTimers.current[resultId]);
          delete pollTimers.current[resultId];
          patchAttr(resultId, { polling: false, timedOut: true });
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      if (!mounted.current) return;
      patchAttr(resultId, { posting: false, error: err instanceof Error ? err.message : "failed to start diagnose" });
    }
  }

  async function openCell(configId: string, questionId: string) {
    setSelected({ configId, questionId });
    const key = cellKey(configId, questionId);
    if (cellCache[key]) return;
    setDrawerLoading(true);
    setDrawerError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/results/${configId}/${questionId}`);
      if (!mounted.current) return;
      setDrawerLoading(false);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDrawerError(body.error ?? "failed to load result");
        return;
      }
      const body: CellDetail = await res.json();
      if (!mounted.current) return;
      setCellCache((prev) => ({ ...prev, [key]: body }));
    } catch (err) {
      if (!mounted.current) return;
      setDrawerLoading(false);
      setDrawerError(err instanceof Error ? err.message : "failed to load result");
    }
  }

  // Only a page with nothing to show is replaced by its error. Once a grid has been rendered, a
  // later failed poll is a banner over data that is merely stale -- swapping the whole page for one
  // line of text on a transient blip throws away the results the user is reading, and the drawer
  // with them.
  if (loadError && !data) return <p role="alert">{loadError}</p>;
  if (!data) return <p>Loading…</p>;

  const { run, configs, grid } = data;
  const selectedDetail = selected ? cellCache[cellKey(selected.configId, selected.questionId)] : undefined;
  const selectedResultId = selectedDetail?.result.id;
  const selectedAttr = selectedResultId ? attrByResult[selectedResultId] : undefined;

  return (
    <div>
      {loadError ? (
        <p role="alert" style={{ color: RED }}>
          {loadError} — showing the last data that loaded.
        </p>
      ) : null}
      <h1>Run {run.id.slice(0, 8)}</h1>
      <p>
        Mode: {run.mode} · Judge: {run.judgeModel ?? "--"}
        {run.mode === "full" ? ` · Answer: ${run.answerModel ?? "(same as judge)"}` : ""}
      </p>
      <p>Status: <span style={{ color: RUN_STATUS_COLOR[run.status] }}>{run.status}</span></p>
      {run.totalJobs > 0 ? <progress value={run.completedJobs} max={run.totalJobs} /> : null}
      {run.error ? <p role="alert">{run.error}</p> : null}

      <section>
        <h2>Config summary</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Config</th>
              <th style={cellStyle}>Top K</th>
              <th style={cellStyle}>Evaluated</th>
              <th style={cellStyle}>Failed</th>
              <th style={cellStyle}>Hit rate</th>
              <th style={cellStyle}>MRR</th>
              <th style={cellStyle}>Faithfulness</th>
              <th style={cellStyle}>Correctness</th>
            </tr>
          </thead>
          <tbody>
            {configs.map((c) => (
              <tr key={c.config.id}>
                <td style={cellStyle}>{c.config.name}</td>
                <td style={cellStyle}>{c.config.topK}</td>
                <td style={cellStyle}>{c.aggregates.evaluated} / {c.aggregates.questions}</td>
                <td style={cellStyle}>{c.aggregates.failed}</td>
                <td style={cellStyle}>{fmtPct(c.aggregates.hitRate)}</td>
                <td style={cellStyle}>{fmtNum(c.aggregates.mrr, 3)}</td>
                <td style={cellStyle}>{fmtNum(c.aggregates.avgFaithfulness)}</td>
                <td style={cellStyle}>{fmtNum(c.aggregates.avgCorrectness)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Questions</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Question</th>
              {configs.map((c) => (
                <th key={c.config.id} style={cellStyle}>{c.config.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row) => (
              <tr key={row.questionId}>
                <td style={cellStyle}>{row.question}</td>
                {configs.map((c) => {
                  const cell = row.perConfig[c.config.id];
                  return (
                    <td key={c.config.id} style={{ ...cellStyle, padding: 0 }}>
                      {cell ? (
                        <button
                          type="button"
                          onClick={() => openCell(c.config.id, row.questionId)}
                          style={{ ...cellButtonStyle, background: cellColor(cell) }}
                        >
                          {cellText(cell)}
                        </button>
                      ) : (
                        <div style={{ ...cellButtonStyle, background: GREY, opacity: 0.35, cursor: "default" }}>
                          pending
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selected ? (
        <section style={{ border: "1px solid #d0d7de", padding: "8px 12px", marginTop: "1em" }}>
          <button type="button" onClick={() => setSelected(null)}>Close</button>
          {drawerLoading ? <p>Loading…</p> : null}
          {drawerError ? <p role="alert">{drawerError}</p> : null}
          {selectedDetail ? (
            <div>
              <h3>{selectedDetail.question.question}</h3>
              <p>Gold answer: {selectedDetail.question.goldAnswer}</p>
              {selectedDetail.result.error ? <p role="alert">{selectedDetail.result.error}</p> : null}

              <h4>Retrieved chunks</h4>
              <table style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={cellStyle}>Rank</th>
                    <th style={cellStyle}>Score</th>
                    <th style={cellStyle}>File</th>
                    <th style={cellStyle}>Text</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedDetail.result.retrieved.map((r) => (
                    <tr key={r.chunkId}>
                      <td style={cellStyle}>{r.rank}</td>
                      <td style={cellStyle}>{r.score.toFixed(3)}</td>
                      <td style={cellStyle}>{r.filename ?? ""}</td>
                      <td style={cellStyle}>{r.text ? truncate(r.text, 300) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4>Answer</h4>
              <p>{selectedDetail.result.answer ?? "(no answer generated)"}</p>

              <h4>Judge</h4>
              <p>
                Faithfulness: {fmtNum(selectedDetail.result.faithfulness)} · Correctness:{" "}
                {fmtNum(selectedDetail.result.correctness)}
              </p>
              {judgeReason(selectedDetail.result.judgeRaw) ? <p>{judgeReason(selectedDetail.result.judgeRaw)}</p> : null}

              <h4>Diagnosis</h4>
              {selectedResultId ? (
                <p>
                  {selectedAttr?.attribution ? (
                    <span
                      style={{
                        background: VERDICT_COLOR[selectedAttr.attribution.verdict], color: "white",
                        padding: "2px 8px", borderRadius: 4, marginRight: 8,
                      }}
                    >
                      {selectedAttr.attribution.verdict}
                    </span>
                  ) : null}
                  {/* decideVerdict's precondition is a missed question -- diagnosing a hit row would
                      run the decision table on an input it was never meant to see (rule 3/4's
                      "unanswerable" fallback fires on a within-k hit, a false verdict). Offer the
                      control only on a genuine miss; a hit row gets an explanatory line instead. */}
                  {!selectedAttr?.attribution && selectedDetail.result.hit === false ? (
                    <button
                      type="button"
                      onClick={() => diagnose(selectedResultId)}
                      disabled={selectedAttr?.posting || selectedAttr?.polling}
                      style={{ marginRight: 8 }}
                    >
                      {selectedAttr?.posting
                        ? "Starting…"
                        : selectedAttr?.polling
                          ? "Diagnosing…"
                          : selectedAttr?.timedOut
                            ? "Try again"
                            : "Diagnose"}
                    </button>
                  ) : null}
                  {selectedDetail.result.hit !== null || selectedAttr?.attribution ? (
                    <Link href={`/results/${selectedResultId}`}>Evidence →</Link>
                  ) : null}
                  {selectedDetail.result.hit === true ? (
                    <span style={{ color: GREY, marginLeft: 8 }}>
                      retrieval hit at rank {rankFromRR(selectedDetail.result.reciprocalRank) ?? "?"} —
                      diagnosis explains retrieval misses
                    </span>
                  ) : null}
                  {selectedAttr?.timedOut ? <span role="alert"> — still not ready after 30s</span> : null}
                  {selectedAttr?.error ? <span role="alert"> — {selectedAttr.error}</span> : null}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
