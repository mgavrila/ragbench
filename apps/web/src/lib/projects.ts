import { and, eq } from "drizzle-orm";
import { projects } from "@ragbench/db";
import { getDb } from "@/lib/db";
import type { Session } from "next-auth";

export async function requireProject(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return null;
  const [project] = await getDb().select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, session.user.organizationId)));
  return project ?? null;
}
