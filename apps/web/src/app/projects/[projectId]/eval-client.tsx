"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";

type ChunkSetOption = {
  id: string;
  chunker: string;
  paramsHash: string;
  /** Every model ever REQUESTED for the set. */
  embedModels: string[];
  /** The subset of those whose vectors actually exist and can therefore be retrieved against. */
  embeddedModels: string[];
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

// Same universe as test-sets-client's GENERATOR_MODELS; duplicated per house style (each client
// keeps its own copy -- plan 6 owns consolidating these).
const LLM_MODELS = ["mock-llm", "claude-haiku-4-5", "claude-opus-5", "gemini-2.5-flash"];
const MODES = ["full", "retrieval-only"] as const;

const RUN_STATUS_COLOR: Record<string, string> = {
  pending: "#57606a",
  running: "#9a6700",
  done: "#1a7f37",
  failed: "#cf222e",
  cancelled: "#57606a",
};

const cellStyle: CSSProperties = { border: "1px solid #d0d7de", padding: "4px 8px", textAlign: "left" };

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
        <p role="status" style={{ color: RUN_STATUS_COLOR.running }}>
          {refreshError} — showing the last data that loaded.
        </p>
      ) : null}
      <section>
        <h2>RAG configs</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Name</th>
              <th style={cellStyle}>Chunk set</th>
              <th style={cellStyle}>Embedding model</th>
              <th style={cellStyle}>Top K</th>
              <th style={cellStyle}>Created</th>
            </tr>
          </thead>
          <tbody>
            {configs.map((c) => (
              <tr key={c.id}>
                <td style={cellStyle}>{c.name}</td>
                <td style={cellStyle}>{c.chunker} ({c.chunkSetId.slice(0, 8)})</td>
                <td style={cellStyle}>{c.embeddingModel}</td>
                <td style={cellStyle}>{c.topK}</td>
                <td style={cellStyle}>{new Date(c.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <form onSubmit={handleCreateConfig}>
          <input
            name="name"
            placeholder="Config name"
            value={configName}
            onChange={(e) => setConfigName(e.target.value)}
            required
          />
          <select value={chunkSetId} onChange={(e) => handleChunkSetChange(e.target.value)} required>
            <option value="" disabled>Chunk set...</option>
            {chunkSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.chunker} ({s.paramsHash.slice(0, 8)}, {s.chunkCount} chunks)
              </option>
            ))}
          </select>
          {/* Options come from every model REQUESTED for the set, so a model whose embed job is
              still queued (or failed) stays visible and accounted for -- but it is disabled until
              its vectors exist, because a config built on it retrieves nothing and every question
              in every run using it fails. */}
          <select value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)} required>
            <option value="" disabled>Embedding model...</option>
            {(selectedChunkSet?.embedModels ?? []).map((m) => {
              const embedded = selectedChunkSet?.embeddedModels.includes(m) ?? false;
              return (
                <option key={m} value={m} disabled={!embedded}>
                  {embedded ? m : `${m} (not embedded yet)`}
                </option>
              );
            })}
          </select>
          <input
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => setTopK(e.target.value)}
            required
          />
          <button type="submit" disabled={!chunkSetId || !embeddingModel}>Create config</button>
        </form>
        {selectedChunkSet && selectedChunkSet.embeddedModels.length === 0 ? (
          <p role="alert">
            {selectedChunkSet.embedModels.length === 0
              ? "This chunk set has no embeddings yet -- request one from the corpus section above."
              : "This chunk set's embeddings are still being built -- no model can be used for retrieval yet."}
          </p>
        ) : null}
        {configError ? <p role="alert">{configError}</p> : null}
      </section>

      <section>
        <h2>Evaluation runs</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Test set</th>
              <th style={cellStyle}>Mode</th>
              <th style={cellStyle}>Status</th>
              <th style={cellStyle}>Progress</th>
              <th style={cellStyle}>Error</th>
              <th style={cellStyle}>Created</th>
              <th style={cellStyle}></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td style={cellStyle}>{r.testSetName}</td>
                <td style={cellStyle}>{r.mode}</td>
                <td style={{ ...cellStyle, color: RUN_STATUS_COLOR[r.status] }}>{r.status}</td>
                <td style={cellStyle}>{r.totalJobs > 0 ? `${r.completedJobs}/${r.totalJobs}` : "--"}</td>
                <td style={cellStyle}>{r.error ?? ""}</td>
                <td style={cellStyle}>{new Date(r.createdAt).toLocaleString()}</td>
                <td style={cellStyle}><Link href={`/runs/${r.id}`}>View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>

        <form onSubmit={handleCreateRun}>
          <select value={testSetId} onChange={(e) => setTestSetId(e.target.value)} required>
            <option value="" disabled>Test set...</option>
            {testSets.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.questionCount} questions, {t.status})</option>
            ))}
          </select>

          <fieldset>
            <legend>Configs (1-6)</legend>
            {configs.map((c) => (
              <label key={c.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={selectedConfigIds.has(c.id)}
                  onChange={() => toggleConfig(c.id)}
                />
                {" "}{c.name} ({c.chunker}, top {c.topK})
                {staleConfigIds?.includes(c.id) ? (
                  <span style={{ color: RUN_STATUS_COLOR.failed }}> -- stale, rebuild its chunk set</span>
                ) : null}
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>Mode</legend>
            {MODES.map((m) => (
              <label key={m} style={{ display: "inline-block", marginRight: "1em" }}>
                <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                {" "}{m}
              </label>
            ))}
          </fieldset>

          <label>
            Judge model{" "}
            <select value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)}>
              {LLM_MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Answer model{" "}
            <select value={answerModel} onChange={(e) => setAnswerModel(e.target.value)}>
              {LLM_MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>

          <button type="submit" disabled={!testSetId || selectedConfigIds.size === 0 || selectedConfigIds.size > 6}>
            Start run
          </button>
        </form>
        {runError ? <p role="alert">{runError}</p> : null}
      </section>
    </div>
  );
}
