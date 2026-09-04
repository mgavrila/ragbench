"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { DataTable } from "@/components/data-table";
import { Notice } from "@/components/notice";
import { cls } from "@/lib/ui";

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
      <p style={{ marginBottom: 12 }}>
        <Link href={`/projects/${testSet.projectId}`}>&larr; Back to project</Link>
      </p>
      <PageHeader
        eyebrow="Test set"
        title={testSet.name}
        meta={
          <span className={cls.row} style={{ gap: 8 }}>
            <StatusBadge status={testSet.status} />
            <span>·</span>
            <span>{testSet.generatorModel}</span>
            <span>·</span>
            {/* Actual count of what's usable, not a ratio against the target -- a ready set that
                landed under target, or a failed set that still generated some questions, are both
                shown plainly rather than framed as a shortfall. */}
            <span>
              {questions.length} question{questions.length === 1 ? "" : "s"} (target{" "}
              {testSet.questionsTarget})
            </span>
          </span>
        }
      />

      {/* A failed set's error is an alert; a ready set's is an advisory (e.g. "kept 0 of 30: ...")
          describing a shortfall, not a failure -- it must not read as one. */}
      {testSet.error ? (
        testSet.status === "failed" ? (
          <Notice>{testSet.error}</Notice>
        ) : (
          <Notice tone="neutral" role="status">
            {testSet.error}
          </Notice>
        )
      ) : null}
      {deleteError ? <Notice>{deleteError}</Notice> : null}

      <DataTable
        isEmpty={questions.length === 0}
        empty={
          <EmptyState
            title={testSet.status === "generating" ? "Generating questions…" : "No questions in this set"}
            hint={
              testSet.status === "generating"
                ? "The generator is reading the corpus. This page refreshes itself while it works."
                : "Every question here was kept only if its gold answer was found verbatim in its source document."
            }
          />
        }
        head={
          <>
            <th>Question</th>
            <th>Gold answer</th>
            <th>Source</th>
            <th className={cls.num}>Span</th>
            <th />
          </>
        }
      >
        {questions.map((q) => (
          <tr key={q.id}>
            <td>{q.question}</td>
            <td>{q.goldAnswer}</td>
            <td className={cls.muted}>{q.filename}</td>
            <td className={cls.num}>
              {q.goldStart}–{q.goldEnd}
            </td>
            <td>
              <button
                type="button"
                className={cls.btnSm}
                onClick={() => handleDelete(q.id)}
                aria-label={`Delete question: ${q.question}`}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
