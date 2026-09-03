"use client";

import { useEffect, useState, type CSSProperties } from "react";
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
};

type Question = {
  id: string;
  documentId: string;
  filename: string;
  question: string;
  goldAnswer: string;
  goldStart: number;
  goldEnd: number;
};

const STATUS_COLOR: Record<string, string> = {
  ready: "#1a7f37",
  generating: "#9a6700",
  failed: "#cf222e",
};

const cellStyle: CSSProperties = { border: "1px solid #d0d7de", padding: "4px 8px", textAlign: "left" };

export function QuestionsClient({ testSetId, initialTestSet }: { testSetId: string; initialTestSet: TestSet }) {
  const [testSet, setTestSet] = useState<TestSet>(initialTestSet);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function refresh() {
    // Two existing endpoints, no new route internals: the questions list has the per-question
    // detail, and the project's test-sets list (already used by test-sets-client) is the only
    // place that reports this set's live status/error, so it doubles as this page's status feed.
    const [qRes, setsRes] = await Promise.all([
      fetch(`/api/test-sets/${testSetId}/questions`),
      fetch(`/api/projects/${testSet.projectId}/test-sets`),
    ]);
    if (qRes.ok) setQuestions((await qRes.json()).questions);
    if (setsRes.ok) {
      const found = (await setsRes.json()).testSets.find((s: { id: string }) => s.id === testSetId);
      if (found) setTestSet((prev) => ({ ...prev, ...found }));
    }
  }

  useEffect(() => {
    refresh();
    if (testSet.status !== "generating") return;
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testSetId, testSet.status]);

  async function handleDelete(questionId: string) {
    setDeleteError(null);
    const res = await fetch(`/api/questions/${questionId}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setDeleteError(body.error ?? "failed to delete question");
    } else {
      await refresh();
    }
  }

  return (
    <div>
      <p><Link href={`/projects/${testSet.projectId}`}>&larr; back to project</Link></p>
      <h1>{testSet.name}</h1>
      <p>
        Model: {testSet.generatorModel} &middot;{" "}
        <span style={{ color: STATUS_COLOR[testSet.status] }}>{testSet.status}</span> &middot;{" "}
        {/* Actual count of what's usable, not a ratio against the target -- a ready set that
            landed under target, or a failed set that still generated some questions, are both
            shown plainly rather than framed as a shortfall. */}
        {questions.length} questions &middot; target {testSet.questionsTarget}
      </p>
      {testSet.error ? <p role="alert">{testSet.error}</p> : null}
      {deleteError ? <p role="alert">{deleteError}</p> : null}

      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Question</th>
            <th style={cellStyle}>Gold answer</th>
            <th style={cellStyle}>Source</th>
            <th style={cellStyle}>Span</th>
            <th style={cellStyle} />
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => (
            <tr key={q.id}>
              <td style={cellStyle}>{q.question}</td>
              <td style={cellStyle}>{q.goldAnswer}</td>
              <td style={cellStyle}>{q.filename}</td>
              <td style={cellStyle}>{q.goldStart}–{q.goldEnd}</td>
              <td style={cellStyle}>
                <button type="button" onClick={() => handleDelete(q.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
