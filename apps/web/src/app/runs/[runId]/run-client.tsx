"use client";

import { useEffect, useState, type CSSProperties } from "react";

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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function fetchOnce() {
      const res = await fetch(`/api/runs/${runId}`);
      if (cancelled) return;
      if (res.ok) {
        const body: RunResponse = await res.json();
        setData(body);
        if (timer && TERMINAL_STATUSES.has(body.run.status)) {
          clearInterval(timer);
          timer = null;
        }
      } else {
        const body = await res.json().catch(() => ({}));
        setLoadError(body.error ?? "failed to load run");
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

  async function openCell(configId: string, questionId: string) {
    setSelected({ configId, questionId });
    const key = cellKey(configId, questionId);
    if (cellCache[key]) return;
    setDrawerLoading(true);
    setDrawerError(null);
    const res = await fetch(`/api/runs/${runId}/results/${configId}/${questionId}`);
    setDrawerLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setDrawerError(body.error ?? "failed to load result");
      return;
    }
    const body: CellDetail = await res.json();
    setCellCache((prev) => ({ ...prev, [key]: body }));
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!data) return <p>Loading…</p>;

  const { run, configs, grid } = data;
  const selectedDetail = selected ? cellCache[cellKey(selected.configId, selected.questionId)] : undefined;

  return (
    <div>
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
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
