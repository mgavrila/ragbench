"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { SectionHead } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { DataTable } from "@/components/data-table";
import { Notice } from "@/components/notice";
import { cls, state } from "@/lib/ui";

type ModelCoverage = { model: string; embedded: number; total: number };

type ChunkSetOption = {
  id: string;
  chunker: string;
  paramsHash: string;
  /** Every model ever REQUESTED for the set. */
  embedModels: string[];
  /** The subset of those whose vectors actually exist and can therefore be retrieved against. */
  embeddedModels: string[];
  /** Per-model `embedded`/`total` chunk counts, which is how a not-yet-usable model says why. */
  modelCoverage: ModelCoverage[];
  chunkCount: number;
};

type Config = {
  id: string;
  projectId: string;
  name: string;
  chunkSetId: string;
  embeddingModel: string;
  topK: number;
  createdAt: string;
  chunker: string;
  chunkSetParams: Record<string, unknown>;
};

type TestSetOption = {
  id: string;
  name: string;
  status: string;
  questionCount: number;
};

type Run = {
  id: string;
  projectId: string;
  testSetId: string;
  testSetName: string;
  mode: string;
  status: string;
  error: string | null;
  totalJobs: number;
  completedJobs: number;
  createdAt: string;
};

// Same universe as test-sets-client's GENERATOR_MODELS.
const LLM_MODELS = ["mock-llm", "claude-haiku-4-5", "claude-opus-5", "gemini-2.5-flash"];
const MODES = ["full", "retrieval-only"] as const;

export function EvalClient({ projectId }: { projectId: string }) {
  const [chunkSets, setChunkSets] = useState<ChunkSetOption[]>([]);
  const [configs, setConfigs] = useState<Config[]>([]);
  const [testSets, setTestSets] = useState<TestSetOption[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);

  const [configName, setConfigName] = useState("");
  const [chunkSetId, setChunkSetId] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [topK, setTopK] = useState("5");
  const [configError, setConfigError] = useState<string | null>(null);

  const [testSetId, setTestSetId] = useState("");
  const [selectedConfigIds, setSelectedConfigIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<(typeof MODES)[number]>("full");
  const [judgeModel, setJudgeModel] = useState<string>(LLM_MODELS[0]);
  const [answerModel, setAnswerModel] = useState<string>(LLM_MODELS[0]);
  const [runError, setRunError] = useState<string | null>(null);
  const [staleConfigIds, setStaleConfigIds] = useState<string[] | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function refresh() {
    // The poll must never reject: an unhandled rejection out of the interval callback is invisible
    // on the page and leaves the tables frozen on whatever last loaded. Same shape as the run
    // page's poll, lighter weight -- one notice, cleared the moment a refresh succeeds again.
    try {
      const [chunkSetsRes, configsRes, testSetsRes, runsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/chunk-sets`),
        fetch(`/api/projects/${projectId}/configs`),
        fetch(`/api/projects/${projectId}/test-sets`),
        fetch(`/api/projects/${projectId}/runs`),
      ]);
      if (chunkSetsRes.ok) setChunkSets((await chunkSetsRes.json()).chunkSets);
      if (configsRes.ok) setConfigs((await configsRes.json()).configs);
      if (testSetsRes.ok) setTestSets((await testSetsRes.json()).testSets);
      if (runsRes.ok) setRuns((await runsRes.json()).runs);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "could not refresh");
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selectedChunkSet = chunkSets.find((s) => s.id === chunkSetId);

  function handleChunkSetChange(id: string) {
    setChunkSetId(id);
    const set = chunkSets.find((s) => s.id === id);
    // Defaults to a model that can actually retrieve, never merely to one that was requested.
    setEmbeddingModel(set?.embeddedModels[0] ?? "");
  }

  async function handleCreateConfig(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setConfigError(null);
    const res = await fetch(`/api/projects/${projectId}/configs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: configName, chunkSetId, embeddingModel, topK: Number(topK) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setConfigError(body.error ?? "failed to create config");
    } else {
      setConfigName("");
      await refresh();
    }
  }

  function toggleConfig(id: string) {
    setSelectedConfigIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleCreateRun(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setRunError(null);
    setStaleConfigIds(null);
    const res = await fetch(`/api/projects/${projectId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        testSetId,
        configIds: [...selectedConfigIds],
        mode,
        judgeModel,
        answerModel,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setRunError(body.error ?? "failed to start run");
      setStaleConfigIds(body.staleConfigIds ?? null);
    } else {
      setSelectedConfigIds(new Set());
      await refresh();
    }
  }

  return (
    <div>
      {refreshError ? (
        <Notice tone="warning" role="status">
          {refreshError} — showing the last data that loaded.
        </Notice>
      ) : null}

      <section className={cls.section}>
        <SectionHead
          title="RAG configs"
          hint="One chunk set plus an embedding model and a top-k cutoff. A run compares several of these side by side."
        />
        <DataTable
          isEmpty={configs.length === 0}
          empty={
            <EmptyState
              title="No configs yet"
              hint="Build one below from a chunk set whose embeddings have finished. Two configs differing in a single knob is what makes a run's grid readable."
            />
          }
          head={
            <>
              <th>Name</th>
              <th>Chunk set</th>
              <th>Embedding model</th>
              <th className={cls.num}>Top K</th>
              <th>Created</th>
            </>
          }
        >
          {configs.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>
                {c.chunker} <span className={cls.mono}>{c.chunkSetId.slice(0, 8)}</span>
              </td>
              <td className={cls.muted}>{c.embeddingModel}</td>
              <td className={cls.num}>{c.topK}</td>
              <td className={cls.muted}>{new Date(c.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </DataTable>

        <form onSubmit={handleCreateConfig} className={cls.form} style={{ marginTop: 12 }}>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Name</span>
            <input
              className={cls.input}
              name="name"
              placeholder="fixed / top 5"
              value={configName}
              onChange={(e) => setConfigName(e.target.value)}
              required
            />
          </label>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Chunk set</span>
            <select
              className={cls.input}
              value={chunkSetId}
              onChange={(e) => handleChunkSetChange(e.target.value)}
              required
            >
              <option value="" disabled>Chunk set...</option>
              {chunkSets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.chunker} ({s.paramsHash.slice(0, 8)}, {s.chunkCount} chunks)
                </option>
              ))}
            </select>
          </label>
          {/* Options are every model REQUESTED for the set (a model with vectors but no request on
              record is not offered -- nothing removes from that array, so in practice requests are
              a superset of what has vectors). A model whose embed job is still queued, running or
              failed partway stays visible and accounted for, but disabled: a config built on it
              retrieves nothing. Its label carries the coverage counts so the option says WHY. */}
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Embedding model</span>
            <select
              className={cls.input}
              value={embeddingModel}
              onChange={(e) => setEmbeddingModel(e.target.value)}
              required
            >
              <option value="" disabled>Embedding model...</option>
              {[...new Set([...(selectedChunkSet?.embedModels ?? []), ...(selectedChunkSet?.embeddedModels ?? [])])].map((m) => {
                const embedded = selectedChunkSet?.embeddedModels.includes(m) ?? false;
                const coverage = selectedChunkSet?.modelCoverage.find((c) => c.model === m);
                return (
                  <option key={m} value={m} disabled={!embedded}>
                    {embedded
                      ? m
                      : coverage
                        ? `${m} (${coverage.embedded}/${coverage.total} chunks embedded)`
                        : `${m} (not embedded yet)`}
                  </option>
                );
              })}
            </select>
          </label>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Top K</span>
            <input
              className={cls.input}
              type="number"
              min={1}
              max={50}
              style={{ width: "5rem" }}
              value={topK}
              onChange={(e) => setTopK(e.target.value)}
              required
            />
          </label>
          <button type="submit" className={cls.btn} disabled={!chunkSetId || !embeddingModel}>
            Create config
          </button>
        </form>
        {selectedChunkSet && selectedChunkSet.embeddedModels.length === 0 ? (
          <Notice tone="warning">
            {selectedChunkSet.embedModels.length === 0
              ? "This chunk set has no embeddings yet -- request one from the corpus section above."
              : "This chunk set's embeddings are still being built -- no model can be used for retrieval yet."}
          </Notice>
        ) : null}
        {configError ? <Notice>{configError}</Notice> : null}
      </section>

      <section className={cls.section}>
        <SectionHead title="Evaluation runs" hint="Every config in a run is scored against the same questions." />
        <DataTable
          isEmpty={runs.length === 0}
          empty={
            <EmptyState
              title="No runs yet"
              hint="Pick a test set and one to six configs below. The run's grid is where a miss becomes a diagnosis."
            />
          }
          head={
            <>
              <th>Test set</th>
              <th>Mode</th>
              <th>Status</th>
              <th className={cls.num}>Progress</th>
              <th>Detail</th>
              <th>Created</th>
              <th />
            </>
          }
        >
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{r.testSetName}</td>
              <td className={cls.muted}>{r.mode}</td>
              <td>
                <StatusBadge status={r.status} />
              </td>
              <td className={cls.num}>{r.totalJobs > 0 ? `${r.completedJobs}/${r.totalJobs}` : "—"}</td>
              <td className={cls.muted}>{r.error ?? ""}</td>
              <td className={cls.muted}>{new Date(r.createdAt).toLocaleString()}</td>
              <td>
                <Link href={`/runs/${r.id}`}>View</Link>
              </td>
            </tr>
          ))}
        </DataTable>

        <form onSubmit={handleCreateRun} className={cls.form} style={{ marginTop: 12, alignItems: "flex-start" }}>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Test set</span>
            <select
              className={cls.input}
              value={testSetId}
              onChange={(e) => setTestSetId(e.target.value)}
              required
            >
              <option value="" disabled>Test set...</option>
              {testSets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.questionCount} questions, {t.status})
                </option>
              ))}
            </select>
          </label>

          <fieldset className={cls.fieldset}>
            <legend>Configs (1-6)</legend>
            {configs.length === 0 ? (
              <span className={cls.muted}>Create a config first.</span>
            ) : (
              configs.map((c) => (
                <label key={c.id} className={cls.choice}>
                  <input
                    type="checkbox"
                    checked={selectedConfigIds.has(c.id)}
                    onChange={() => toggleConfig(c.id)}
                  />
                  <span>
                    {c.name}{" "}
                    <span className={cls.muted}>
                      ({c.chunker}, top {c.topK})
                    </span>
                    {staleConfigIds?.includes(c.id) ? (
                      <span style={{ color: state.danger }}> — stale, rebuild its chunk set</span>
                    ) : null}
                  </span>
                </label>
              ))
            )}
          </fieldset>

          <fieldset className={cls.fieldset}>
            <legend>Mode</legend>
            {MODES.map((m) => (
              <label key={m} className={cls.choiceInline}>
                <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                <span>{m}</span>
              </label>
            ))}
          </fieldset>

          <label className={cls.field}>
            <span className={cls.fieldLabel}>Judge model</span>
            <select className={cls.input} value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)}>
              {LLM_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Answer model</span>
            <select className={cls.input} value={answerModel} onChange={(e) => setAnswerModel(e.target.value)}>
              {LLM_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className={cls.btnPrimary}
            disabled={!testSetId || selectedConfigIds.size === 0 || selectedConfigIds.size > 6}
          >
            Start run
          </button>
        </form>
        {runError ? <Notice>{runError}</Notice> : null}
      </section>
    </div>
  );
}
