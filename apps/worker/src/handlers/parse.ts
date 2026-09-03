import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { documents, documentPath } from "@ragbench/db";
import type { JobHandler } from "../queue";

export const parseHandler: JobHandler<{ documentId: string }> = async ({ documentId }, { db }) => {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return; // deleted meanwhile — idempotent no-op
  try {
    const raw = await readFile(documentPath(documentId));
    let text: string;
    if (doc.mime === "application/pdf") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      // verbosity: 0 suppresses pdf.js's stdout warnings (e.g. "Indexing all PDF objects" on
      // documents without a proper xref table) — extraction errors still throw and are handled below.
      const pdf = await getDocumentProxy(new Uint8Array(raw), { verbosity: 0 });
      const extracted = await extractText(pdf, { mergePages: true });
      text = extracted.text;
    } else {
      text = raw.toString("utf-8");
    }
    const contentHash = createHash("sha256").update(raw).digest("hex");
    await db.update(documents)
      .set({ text, contentHash, status: "ready", error: null })
      .where(eq(documents.id, documentId));
  } catch (err) {
    await db.update(documents)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .where(eq(documents.id, documentId));
  }
};
