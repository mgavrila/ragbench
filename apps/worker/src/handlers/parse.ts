import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, ne } from "drizzle-orm";
import { documents, documentPath } from "@ragbench/db";
import type { JobHandler } from "../queue";

/**
 * utf-8 decoding never throws -- invalid bytes become U+FFFD -- so a binary file uploaded under a
 * text mime decodes "successfully" into garbage. Its signature is a high density of replacement
 * characters and C0 control bytes, which real text does not have. A stray NUL or two in an
 * otherwise normal document stays far below the threshold and is stripped rather than rejected.
 */
function nonPrintableRatio(text: string): number {
  if (text.length === 0) return 0;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x09 || code === 0xfffd) bad++;
  }
  return bad / text.length;
}

/**
 * Shared post-extraction cleanup for both branches. Postgres rejects NUL in text values outright,
 * so a single stray one -- from either a mislabeled text file or a PDF extraction artifact -- would
 * fail the ready-update below and put the document into a retry loop it can never leave. The
 * printability check only applies to the text branch: a PDF is already known to be a real PDF by
 * its magic bytes, so its extracted text isn't screened for looking like binary mojibake.
 */
export function sanitizeExtractedText(text: string, { checkPrintable }: { checkPrintable: boolean }): string {
  if (checkPrintable && nonPrintableRatio(text) > 0.1) throw new Error("file does not appear to be text");
  return text.replaceAll("\u0000", "");
}

export const parseHandler: JobHandler<{ documentId: string }> = async ({ documentId }, { db }) => {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return; // deleted meanwhile — idempotent no-op

  // Only file-read/extraction/hash failures are attributed to the document (bad file, fatal, not
  // retryable). A DB error below this block must NOT be caught here — catching it would mislabel
  // a transient DB problem as a parse failure and permanently mark the document "failed" instead
  // of letting pg-boss retry the job (parseHandler is idempotent, so a retry is safe).
  let text: string;
  let contentHash: string;
  try {
    const raw = await readFile(documentPath(documentId));
    // The branch is chosen by content, not by the client-declared mime: a PDF uploaded as
    // text/plain would otherwise be decoded as text and stored as mojibake, and the mime is
    // whatever the browser or curl caller felt like sending.
    if (raw.subarray(0, 5).toString("latin1") === "%PDF-") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      // verbosity: 0 suppresses pdf.js's stdout warnings (e.g. "Indexing all PDF objects" on
      // documents without a proper xref table) — extraction errors still throw and are handled below.
      const pdf = await getDocumentProxy(new Uint8Array(raw), { verbosity: 0 });
      const extracted = await extractText(pdf, { mergePages: true });
      text = sanitizeExtractedText(extracted.text, { checkPrintable: false });
    } else {
      const decoded = raw.toString("utf-8");
      text = sanitizeExtractedText(decoded, { checkPrintable: true });
    }
    contentHash = createHash("sha256").update(raw).digest("hex");
  } catch (err) {
    await db.update(documents)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .where(eq(documents.id, documentId));
    return;
  }

  // Duplicate detection and the ready-update both run outside the extraction try above, same as
  // that block's own failure-attribution discipline requires: a DB error here must propagate and
  // retry the job rather than being mislabeled as a bad file.
  const [existingReady] = await db.select().from(documents).where(and(
    eq(documents.projectId, doc.projectId),
    eq(documents.contentHash, contentHash),
    eq(documents.status, "ready"),
    ne(documents.id, documentId),
  ));

  if (existingReady) {
    await db.update(documents)
      .set({ text, contentHash, status: "duplicate", error: `duplicate of ${existingReady.filename}` })
      .where(eq(documents.id, documentId));
  } else {
    await db.update(documents)
      .set({ text, contentHash, status: "ready", error: null })
      .where(eq(documents.id, documentId));
  }
};
