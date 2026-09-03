import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function uploadsDir(): string {
  const dir = process.env.RAGBENCH_UPLOADS_DIR ?? join(process.cwd(), "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function documentPath(documentId: string): string {
  return join(uploadsDir(), documentId);
}
