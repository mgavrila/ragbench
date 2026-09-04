"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { SectionHead } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { DataTable } from "@/components/data-table";
import { Notice } from "@/components/notice";
import { cls, state } from "@/lib/ui";

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
    // Debounced: the count input fires this effect on every keystroke ("30" typed over an empty
    // field is 1, then 3, then 30), and each estimate is a request that reads the project's
    // documents. The cancelled flag still guards the response, so a request already in flight when
    // the inputs change cannot overwrite the estimate for the newer ones.
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/projects/${projectId}/test-sets/estimate?model=${encodeURIComponent(model)}&count=${count}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => { if (!cancelled) setEstimate(body); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
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
    <section className={cls.section} id="test-sets">
      <SectionHead
        title="Test sets"
        hint="Questions generated from the corpus, each with a gold answer span in its source document."
      />
      <DataTable
        isEmpty={testSets.length === 0}
        empty={
          <EmptyState
            title="No test sets yet"
            hint="Generate one below. Every run scores its configs against the questions in a single test set."
          />
        }
        head={
          <>
            <th>Name</th>
            <th>Model</th>
            <th>Status</th>
            {/* Not "Error": a ready set can carry an advisory here (why a run kept nothing), and
                labelling that an error contradicts the status sitting next to it. */}
            <th>Detail</th>
            <th className={cls.num}>Questions</th>
            <th>Created</th>
          </>
        }
      >
        {testSets.map((s) => (
          <tr key={s.id}>
            <td>
              <Link href={`/test-sets/${s.id}`}>{s.name}</Link>
            </td>
            <td className={cls.muted}>{s.generatorModel}</td>
            <td>
              <StatusBadge status={s.status} />
            </td>
            <td className={cls.muted}>{s.error ?? ""}</td>
            {/* Actual count, not a "N/target" ratio -- a set can finish ready under target and
                that is a legitimate result, not a shortfall to flag. */}
            <td className={cls.num}>{s.questionCount}</td>
            <td className={cls.muted}>{new Date(s.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </DataTable>

      <form onSubmit={handleCreate} className={cls.form} style={{ marginTop: 12 }}>
        <label className={cls.field}>
          <span className={cls.fieldLabel}>Name</span>
          <input
            className={cls.input}
            name="name"
            placeholder="Round 1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className={cls.field}>
          <span className={cls.fieldLabel}>Generator model</span>
          <select className={cls.input} value={model} onChange={(e) => setModel(e.target.value)}>
            {GENERATOR_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className={cls.field}>
          <span className={cls.fieldLabel}>Questions</span>
          <input
            className={cls.input}
            type="number"
            min={1}
            max={200}
            style={{ width: "6rem" }}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
          />
        </label>
        <button type="submit" className={cls.btn}>
          Generate test set
        </button>
      </form>

      {estimate ? (
        <p className={cls.muted} style={{ marginTop: 8, fontSize: 13 }}>
          Estimated cost{" "}
          <span className={cls.mono} style={{ color: "var(--rb-text)" }}>
            ~${estimate.estimatedUsd.toFixed(4)}
          </span>{" "}
          over {estimate.documents} ready document{estimate.documents === 1 ? "" : "s"}
          {estimate.warning ? (
            <>
              <br />
              <span style={{ color: state.warning }}>{estimate.warning}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {createError ? <Notice>{createError}</Notice> : null}
    </section>
  );
}
