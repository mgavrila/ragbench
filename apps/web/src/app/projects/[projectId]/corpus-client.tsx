"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";

type Document = {
  id: string;
  filename: string;
  mime: string;
  status: string;
  error: string | null;
  createdAt: string;
};

type ChunkSet = {
  id: string;
  chunker: string;
  params: Record<string, unknown>;
  paramsHash: string;
  createdAt: string;
  chunkCount: number;
};

const CHUNKERS = ["fixed", "heading", "sentence-window"] as const;
const EMBED_MODELS = ["mock-embedding", "text-embedding-3-small", "gemini-embedding-001"];

const STATUS_COLOR: Record<string, string> = {
  ready: "#1a7f37",
  parsing: "#9a6700",
  failed: "#cf222e",
};

const cellStyle: CSSProperties = { border: "1px solid #d0d7de", padding: "4px 8px", textAlign: "left" };

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
      <section>
        <h2>Documents</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Filename</th>
              <th style={cellStyle}>Status</th>
              <th style={cellStyle}>Error</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td style={cellStyle}>{d.filename}</td>
                <td style={{ ...cellStyle, color: STATUS_COLOR[d.status] }}>{d.status}</td>
                <td style={cellStyle}>{d.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={handleUpload}>
          <input type="file" name="file" required />
          <button type="submit">Upload</button>
        </form>
        {uploadError ? <p role="alert">{uploadError}</p> : null}
      </section>

      <section>
        <h2>Chunk sets</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Chunker</th>
              <th style={cellStyle}>Params hash</th>
              <th style={cellStyle}>Chunks</th>
            </tr>
          </thead>
          <tbody>
            {chunkSets.map((s) => (
              <tr key={s.id}>
                <td style={cellStyle}>{s.chunker}</td>
                <td style={cellStyle}>{s.paramsHash.slice(0, 8)}</td>
                <td style={cellStyle}>{s.chunkCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={handleCreateChunkSet}>
          <select value={chunker} onChange={(e) => setChunker(e.target.value as (typeof CHUNKERS)[number])}>
            {CHUNKERS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select value={embedModel} onChange={(e) => setEmbedModel(e.target.value)}>
            <option value="">(no embedding)</option>
            {EMBED_MODELS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button type="submit">Create chunk set</button>
        </form>
        {chunkSetError ? <p role="alert">{chunkSetError}</p> : null}
      </section>
    </div>
  );
}
