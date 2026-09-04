"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Attribution } from "@/lib/attribution";
import { PageHeader, SectionHead } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { DataTable } from "@/components/data-table";
import { Notice } from "@/components/notice";
import { cellTone, cls, cx, state, VERDICT_TONE } from "@/lib/ui";

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
// writes no row at all -- see the polling contract in
// apps/web/src/app/api/results/[resultId]/attribution/route.ts) re-enables the button instead of
// spinning forever.
const POLL_TIMEOUT_MS = 30000;

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number | null, digits = 2): string {
  return v === null ? "—" : v.toFixed(digits);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
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
  if (loadError && !data) return <Notice>{loadError}</Notice>;
  if (!data) return <p className={cls.muted}>Loading…</p>;

  const { run, configs, grid } = data;
  const selectedDetail = selected ? cellCache[cellKey(selected.configId, selected.questionId)] : undefined;
  const selectedResultId = selectedDetail?.result.id;
  const selectedAttr = selectedResultId ? attrByResult[selectedResultId] : undefined;
  const selectedHit = selectedDetail?.result.hit;

  return (
    <div>
      {loadError ? <Notice role="status" tone="warning">{loadError} — showing the last data that loaded.</Notice> : null}

      <PageHeader
        eyebrow="Run"
        title={<span className={cls.mono} style={{ fontSize: 20 }}>{run.id.slice(0, 8)}</span>}
        meta={
          <span className={cls.row} style={{ gap: 8 }}>
            <StatusBadge status={run.status} />
            <span>·</span>
            <span>{run.mode}</span>
            <span>·</span>
            <span>judge {run.judgeModel ?? "—"}</span>
            {run.mode === "full" ? (
              <>
                <span>·</span>
                <span>answer {run.answerModel ?? "(same as judge)"}</span>
              </>
            ) : null}
          </span>
        }
        actions={
          <Link href={`/projects/${run.projectId}`} className={cls.btn}>
            Back to project
          </Link>
        }
      />

      {run.totalJobs > 0 ? (
        <p className={cls.row} style={{ marginBottom: 24 }}>
          <progress
            className={cls.progress}
            value={run.completedJobs}
            max={run.totalJobs}
            aria-label="Run progress"
          />
          <span className={cx(cls.mono, cls.muted)}>
            {run.completedJobs}/{run.totalJobs} jobs
          </span>
        </p>
      ) : null}
      {run.error ? <Notice>{run.error}</Notice> : null}

      <section className={cls.section}>
        <SectionHead title="Config summary" hint="One row per config, over the whole test set." />
        <DataTable
          isEmpty={configs.length === 0}
          empty={<EmptyState title="This run has no configs" />}
          head={
            <>
              <th>Config</th>
              <th className={cls.num}>Top K</th>
              <th className={cls.num}>Evaluated</th>
              <th className={cls.num}>Failed</th>
              <th className={cls.num}>Hit rate</th>
              <th className={cls.num}>MRR</th>
              <th className={cls.num}>Faithfulness</th>
              <th className={cls.num}>Correctness</th>
            </>
          }
        >
          {configs.map((c) => (
            <tr key={c.config.id}>
              <td>{c.config.name}</td>
              <td className={cls.num}>{c.config.topK}</td>
              <td className={cls.num}>
                {c.aggregates.evaluated}/{c.aggregates.questions}
              </td>
              <td className={cls.num} style={{ color: c.aggregates.failed > 0 ? state.danger : undefined }}>
                {c.aggregates.failed}
              </td>
              <td className={cls.num}>{fmtPct(c.aggregates.hitRate)}</td>
              <td className={cls.num}>{fmtNum(c.aggregates.mrr, 3)}</td>
              <td className={cls.num}>{fmtNum(c.aggregates.avgFaithfulness)}</td>
              <td className={cls.num}>{fmtNum(c.aggregates.avgCorrectness)}</td>
            </tr>
          ))}
        </DataTable>
      </section>

      <section className={cls.section}>
        <SectionHead title="Questions" hint="Select a cell to inspect what that config retrieved." />
        <DataTable
          className={cls.grid}
          isEmpty={grid.length === 0}
          empty={
            <EmptyState
              title="No questions in this run's test set"
              hint="Nothing was scheduled, so there is nothing to grade."
            />
          }
          head={
            <>
              <th>Question</th>
              {configs.map((c) => (
                <th key={c.config.id}>{c.config.name}</th>
              ))}
            </>
          }
        >
          {grid.map((row) => (
            <tr key={row.questionId}>
              <td className={cls.gridQuestion}>{row.question}</td>
              {configs.map((c) => {
                const cell = row.perConfig[c.config.id];
                const isSelected =
                  selected?.configId === c.config.id && selected?.questionId === row.questionId;
                return (
                  <td key={c.config.id}>
                    {cell ? (
                      <button
                        type="button"
                        onClick={() => openCell(c.config.id, row.questionId)}
                        className={cx(cls.cell, isSelected && cls.cellSelected)}
                        style={{ background: state[cellTone(cell)] }}
                        aria-pressed={isSelected}
                        aria-label={`${c.config.name}: ${cellText(cell)} — ${truncate(row.question, 80)}`}
                      >
                        {cellText(cell)}
                      </button>
                    ) : (
                      // Not a button: nothing has been scheduled for this pair yet, so there is no
                      // result to open. Its own text carries the meaning, no aria-label needed.
                      <div className={cls.cellPending}>pending</div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </DataTable>
      </section>

      {selected ? (
        <section className={cls.drawer} aria-label="Result detail">
          <div className={cls.drawerHead}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span className={cls.eyebrow}>Result</span>
              <h3>{selectedDetail?.question.question ?? "Loading…"}</h3>
              {selectedDetail ? (
                <p className={cls.muted} style={{ marginTop: 4 }}>
                  Gold answer: {selectedDetail.question.goldAnswer}
                </p>
              ) : null}
            </div>
            <div className={cls.row}>
              {/* Always available, at every status: the evidence view renders the document with the
                  gold span and chunk boundaries whether or not the row has been evaluated, and a
                  pending cell is exactly when someone wants to look at the source. */}
              {selectedResultId ? (
                <Link href={`/results/${selectedResultId}`} className={cls.btn}>
                  Evidence →
                </Link>
              ) : null}
              <button
                type="button"
                className={cls.btn}
                onClick={() => setSelected(null)}
                aria-label="Close result detail"
              >
                Close
              </button>
            </div>
          </div>

          {drawerLoading ? <p className={cls.muted}>Loading…</p> : null}
          {drawerError ? <Notice>{drawerError}</Notice> : null}

          {selectedDetail ? (
            <div>
              {selectedDetail.result.error ? <Notice>{selectedDetail.result.error}</Notice> : null}

              <div className={cls.drawerBlock}>
                <SectionHead title="Retrieved chunks" />
                <DataTable
                  isEmpty={selectedDetail.result.retrieved.length === 0}
                  empty={<EmptyState title="Nothing was retrieved for this question" />}
                  head={
                    <>
                      <th className={cls.num}>Rank</th>
                      <th className={cls.num}>Score</th>
                      <th>File</th>
                      <th>Text</th>
                    </>
                  }
                >
                  {selectedDetail.result.retrieved.map((r) => (
                    <tr key={r.chunkId}>
                      <td className={cls.num}>{r.rank}</td>
                      <td className={cls.num}>{r.score.toFixed(3)}</td>
                      <td className={cls.muted}>{r.filename ?? ""}</td>
                      <td>{r.text ? truncate(r.text, 300) : ""}</td>
                    </tr>
                  ))}
                </DataTable>
              </div>

              <div className={cls.drawerBlock}>
                <SectionHead title="Answer" />
                <div className={cls.cardPad}>
                  {selectedDetail.result.answer ?? (
                    <span className={cls.muted}>(no answer generated)</span>
                  )}
                </div>
              </div>

              <div className={cls.drawerBlock}>
                <SectionHead
                  title="Judge"
                  hint={
                    <>
                      faithfulness <span className={cls.mono}>{fmtNum(selectedDetail.result.faithfulness)}</span>
                      {" · "}
                      correctness <span className={cls.mono}>{fmtNum(selectedDetail.result.correctness)}</span>
                    </>
                  }
                />
                {judgeReason(selectedDetail.result.judgeRaw) ? (
                  <div className={cls.cardPad}>{judgeReason(selectedDetail.result.judgeRaw)}</div>
                ) : (
                  <p className={cls.muted}>(no judge reasoning recorded)</p>
                )}
              </div>

              {/* The heading appears only when there is a diagnosis to show or an action to offer.
                  A cell still pending (hit === null, never diagnosed) has neither, and a bare
                  "Diagnosis" heading over nothing reads as a section that failed to load. */}
              {selectedResultId && (selectedAttr?.attribution || selectedHit !== null) ? (
                <div className={cls.drawerBlock}>
                  <SectionHead title="Diagnosis" />
                  <p className={cls.row}>
                    {selectedAttr?.attribution ? (
                      <StatusBadge
                        status={selectedAttr.attribution.verdict}
                        tone={VERDICT_TONE[selectedAttr.attribution.verdict]}
                        variant="solid"
                      />
                    ) : null}
                    {/* decideVerdict's precondition is a missed question -- diagnosing a hit row would
                        run the decision table on an input it was never meant to see (rule 3/4's
                        "unanswerable" fallback fires on a within-k hit, a false verdict). Offer the
                        control only on a genuine miss; a hit row gets an explanatory line instead. */}
                    {!selectedAttr?.attribution && selectedHit === false ? (
                      <button
                        type="button"
                        className={cls.btn}
                        onClick={() => diagnose(selectedResultId)}
                        disabled={selectedAttr?.posting || selectedAttr?.polling}
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
                    {selectedHit === true ? (
                      <span className={cls.muted}>
                        retrieval hit at rank {rankFromRR(selectedDetail.result.reciprocalRank) ?? "?"} —
                        diagnosis explains retrieval misses
                      </span>
                    ) : null}
                    {selectedAttr?.timedOut ? (
                      <span role="alert" style={{ color: state.warning }}>
                        still not ready after 30s
                      </span>
                    ) : null}
                    {selectedAttr?.error ? (
                      <span role="alert" style={{ color: state.danger }}>
                        {selectedAttr.error}
                      </span>
                    ) : null}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
