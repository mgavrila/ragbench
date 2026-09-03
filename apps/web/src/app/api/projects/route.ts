import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { projects } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";

/**
 * Just the part of the session these handlers read. Dropping `expires` keeps them callable from
 * tests with a plain object while an `auth()` result still satisfies it structurally.
 */
type SessionLike = Pick<Session, "user"> | null;

export async function listProjects(session: SessionLike) {
  if (!session?.user?.organizationId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await getDb().select().from(projects)
    .where(eq(projects.organizationId, session.user.organizationId));
  return NextResponse.json({ projects: rows });
}

export async function createProject(req: Request, session: SessionLike) {
  if (!session?.user?.organizationId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = z.object({ name: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const [project] = await getDb().insert(projects).values({
    organizationId: session.user.organizationId, name: parsed.data.name,
  }).returning();
  return NextResponse.json({ project }, { status: 201 });
}

export async function GET() {
  return listProjects(await auth());
}

export async function POST(req: Request) {
  return createProject(req, await auth());
}
