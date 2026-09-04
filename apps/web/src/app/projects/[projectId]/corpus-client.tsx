"use client";

import { useEffect, useState, type FormEvent } from "react";
import { SectionHead } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { DataTable } from "@/components/data-table";
import { Notice } from "@/components/notice";
import { cls, state } from "@/lib/ui";

type Document = {
  id: string;
  filename: string;
  mime: string;
  status: string;
  error: string | null;
  createdAt: string;
};

type ModelCoverage = { model: string; embedded: number; total: number };

type ChunkSet = {
  id: string;
  chunker: string;
  params: Record<string, unknown>;
  paramsHash: string;
  embedModels: string[];
  embedError: string | null;
  createdAt: string;
  chunkCount: number;
  modelCoverage: ModelCoverage[];
};

const CHUNKERS = ["fixed", "heading", "sentence-window"] as const;
const EMBED_MODELS = ["mock-embedding", "text-embedding-3-small", "gemini-embedding-001"];

export function CorpusClient({ projectId }: { projectId: string }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [chunkSets, setChunkSets] = useState<ChunkSet[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [chunkSetError, setChunkSetError] = useState<string | null>(null);
  const [chunker, setChunker] = useState<(typeof CHUNKERS)[number]>("fixed");
  const [embedModel, setEmbedModel] = useState<string>("");

  async function refresh() {
    const [docsRes, setsRes] = await Promise.all([
      fetch(`/api/projects/${projectId}/documents`),
      fetch(`/api/projects/${projectId}/chunk-sets`),
    ]);
    if (docsRes.ok) setDocuments((await docsRes.json()).documents);
    if (setsRes.ok) setChunkSets((await setsRes.json()).chunkSets);
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setUploadError(null);
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    const res = await fetch(`/api/projects/${projectId}/documents`, { method: "POST", body: fd });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setUploadError(body.error ?? "upload failed");
    } else {
      form.reset();
      await refresh();
    }
  }

  async function handleCreateChunkSet(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setChunkSetError(null);
    const res = await fetch(`/api/projects/${projectId}/chunk-sets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chunker, embedModel: embedModel || undefined }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setChunkSetError(body.error ?? "failed to create chunk set");
    } else {
      await refresh();
    }
  }

  return (
    <div>
      <section className={cls.section} id="corpus">
        <SectionHead
          title="Documents"
          hint={documents.length > 0 ? `${documents.length} uploaded` : undefined}
        />
        <DataTable
          isEmpty={documents.length === 0}
          empty={
            <EmptyState
              title="No documents yet"
              hint="Upload a text or markdown file to start. Questions are generated from these documents, and every gold span points back into one of them."
            />
          }
          head={
            <>
              <th>Filename</th>
              <th>Status</th>
              <th>Detail</th>
            </>
          }
        >
          {documents.map((d) => (
            <tr key={d.id}>
              <td>{d.filename}</td>
              <td>
                <StatusBadge status={d.status} />
              </td>
              <td className={cls.muted}>{d.error ?? ""}</td>
            </tr>
          ))}
        </DataTable>

        <form onSubmit={handleUpload} className={cls.form} style={{ marginTop: 12 }}>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Add a document</span>
            <input className={cls.input} type="file" name="file" required />
          </label>
          <button type="submit" className={cls.btn}>
            Upload
          </button>
        </form>
        {uploadError ? <Notice>{uploadError}</Notice> : null}
      </section>

      <section className={cls.section}>
        <SectionHead
          title="Chunk sets"
          hint="One chunker plus its parameters. Re-running a chunker re-chunks every document currently in the project."
        />
        <DataTable
          isEmpty={chunkSets.length === 0}
          empty={
            <EmptyState
              title="No chunk sets yet"
              hint="Pick a chunker and an embedding model below. A config can only retrieve against a set whose chunks are fully embedded."
            />
          }
          head={
            <>
              <th>Chunker</th>
              <th>Params</th>
              <th className={cls.num}>Chunks</th>
              <th>Embeddings</th>
              <th>Detail</th>
            </>
          }
        >
          {chunkSets.map((s) => (
            <tr key={s.id}>
              <td>{s.chunker}</td>
              <td className={cls.mono}>{s.paramsHash.slice(0, 8)}</td>
              <td className={cls.num}>{s.chunkCount}</td>
              <td>
                {s.modelCoverage.length === 0 ? (
                  <span className={cls.muted}>none requested</span>
                ) : (
                  <span className={cls.stack} style={{ gap: 2 }}>
                    {s.modelCoverage.map((m) => {
                      const complete = m.total > 0 && m.embedded === m.total;
                      return (
                        <span key={m.model} style={{ whiteSpace: "nowrap" }}>
                          {m.model}{" "}
                          <span
                            className={cls.mono}
                            style={{ color: complete ? state.success : state.warning }}
                          >
                            {m.embedded}/{m.total}
                          </span>
                        </span>
                      );
                    })}
                  </span>
                )}
              </td>
              <td style={{ color: s.embedError ? state.danger : undefined }}>{s.embedError ?? ""}</td>
            </tr>
          ))}
        </DataTable>

        <form onSubmit={handleCreateChunkSet} className={cls.form} style={{ marginTop: 12 }}>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Chunker</span>
            <select
              className={cls.input}
              value={chunker}
              onChange={(e) => setChunker(e.target.value as (typeof CHUNKERS)[number])}
            >
              {CHUNKERS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Embedding model</span>
            <select className={cls.input} value={embedModel} onChange={(e) => setEmbedModel(e.target.value)}>
              <option value="">(no embedding)</option>
              {EMBED_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={cls.btn}>
            Create chunk set
          </button>
        </form>
        {chunkSetError ? <Notice>{chunkSetError}</Notice> : null}
      </section>
    </div>
  );
}
