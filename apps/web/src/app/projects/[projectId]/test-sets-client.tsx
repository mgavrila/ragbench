"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";

type TestSet = {
  id: string;
  projectId: string;
  name: string;
  generatorModel: string;
  status: string;
  error: string | null;
  questionsTarget: number;
  createdAt: string;
  questionCount: number;
};

type Estimate = {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  documents: number;
  warning?: string;
};

const GENERATOR_MODELS = ["mock-llm", "claude-haiku-4-5", "claude-opus-5", "gemini-2.5-flash"];

// "generating" reuses the same amber as corpus-client's in-flight "parsing" status, so the two
// sections read consistently even though they track different tables.
const STATUS_COLOR: Record<string, string> = {
  ready: "#1a7f37",
  generating: "#9a6700",
  failed: "#cf222e",
};

const cellStyle: CSSProperties = { border: "1px solid #d0d7de", padding: "4px 8px", textAlign: "left" };

export function TestSetsClient({ projectId }: { projectId: string }) {
  const [testSets, setTestSets] = useState<TestSet[]>([]);
  const [name, setName] = useState("");
  const [model, setModel] = useState<string>(GENERATOR_MODELS[0]);
  const [target, setTarget] = useState("30");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch(`/api/projects/${projectId}/test-sets`);
    if (res.ok) setTestSets((await res.json()).testSets);
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const count = Number(target);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${projectId}/test-sets/estimate?model=${encodeURIComponent(model)}&count=${count}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (!cancelled) setEstimate(body); });
    return () => { cancelled = true; };
  }, [projectId, model, target]);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreateError(null);
    const res = await fetch(`/api/projects/${projectId}/test-sets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, generatorModel: model, questionsTarget: Number(target) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setCreateError(body.error ?? "failed to create test set");
    } else {
      setName("");
      await refresh();
    }
  }

  return (
    <section>
      <h2>Test sets</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Name</th>
            <th style={cellStyle}>Model</th>
            <th style={cellStyle}>Status</th>
            <th style={cellStyle}>Error</th>
            <th style={cellStyle}>Questions</th>
            <th style={cellStyle}>Created</th>
          </tr>
        </thead>
        <tbody>
          {testSets.map((s) => (
            <tr key={s.id}>
              <td style={cellStyle}><Link href={`/test-sets/${s.id}`}>{s.name}</Link></td>
              <td style={cellStyle}>{s.generatorModel}</td>
              <td style={{ ...cellStyle, color: STATUS_COLOR[s.status] }}>{s.status}</td>
              <td style={cellStyle}>{s.error ?? ""}</td>
              {/* Actual count, not a "N/target" ratio -- a set can finish ready under target and
                  that is a legitimate result, not a shortfall to flag. */}
              <td style={cellStyle}>{s.questionCount} questions</td>
              <td style={cellStyle}>{new Date(s.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={handleCreate}>
        <input
          name="name"
          placeholder="Test set name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {GENERATOR_MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={200}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          required
        />
        <button type="submit">Generate test set</button>
      </form>

      {estimate ? (
        <p>
          Estimated cost: ~${estimate.estimatedUsd.toFixed(4)} ({estimate.documents} ready document{estimate.documents === 1 ? "" : "s"})
          {estimate.warning ? <><br /><span style={{ color: STATUS_COLOR.generating }}>{estimate.warning}</span></> : null}
        </p>
      ) : null}
      {createError ? <p role="alert">{createError}</p> : null}
    </section>
  );
}
