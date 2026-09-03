import { createHash } from "node:crypto";

// Identifies "nothing that would change a chunk set's chunks has changed since its last rebuild":
// the chunker params (via the set's already-stored paramsHash) and the exact set of ready
// documents' content (via their contentHashes, sorted so document order doesn't matter). A doc
// flipping to "ready" or "duplicate"/"failed" changes which contentHashes are in the join, so it
// changes the fingerprint and forces a rebuild. Lives in @ragbench/db (rather than the worker) so
// both the chunk handler and the web runs route can compute it without the worker as a dependency.
export function computeFingerprint(paramsHash: string, contentHashes: string[]): string {
  const sortedHashes = [...contentHashes].sort().join(",");
  return createHash("sha256").update(`${paramsHash}:${sortedHashes}`).digest("hex");
}
