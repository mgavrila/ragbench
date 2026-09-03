import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { documents, documentPath } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import { sendJob } from "@/lib/queue";
import type { Session } from "next-auth";

const ALLOWED_MIMES = new Set(["application/pdf", "text/markdown", "text/plain"]);
const MAX_BYTES = 20 * 1024 * 1024;

export async function listDocuments(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rows = await getDb().select({
    id: documents.id, filename: documents.filename, mime: documents.mime,
    status: documents.status, error: documents.error, createdAt: documents.createdAt,
  }).from(documents).where(eq(documents.projectId, projectId));
  return NextResponse.json({ documents: rows });
}

export async function uploadDocument(
  projectId: string, req: Request, session: Session | null,
  send: (queue: string, data: object, key: string) => Promise<void> = sendJob,
) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file field required" }, { status: 400 });
  if (!ALLOWED_MIMES.has(file.type)) return NextResponse.json({ error: `unsupported type: ${file.type}` }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large (max 20MB)" }, { status: 413 });

  const [doc] = await getDb().insert(documents).values({
    projectId, filename: file.name, mime: file.type, contentHash: "pending", status: "parsing",
  }).returning();
  const path = documentPath(doc.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await file.arrayBuffer()));
  await send("parse", { documentId: doc.id }, doc.id);
  return NextResponse.json({ document: doc }, { status: 201 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return listDocuments(projectId, await auth());
}

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return uploadDocument(projectId, req, await auth());
}
