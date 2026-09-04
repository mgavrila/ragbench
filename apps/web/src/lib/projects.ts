import { and, eq } from "drizzle-orm";
import { projects } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { parseUuid } from "@/lib/params";
import type { Session } from "next-auth";

/**
 * The org gate for everything under `/projects/:projectId`. A malformed projectId is rejected here
 * rather than at each of the dozen call sites: it reads as "no such project" exactly like an
 * unknown one, and every caller already turns null into a 404 or notFound(). See parseUuid for why
 * the unvalidated string must not reach the query.
 */
export async function requireProject(projectId: string, session: Session | null) {
  if (!session?.user?.organizationId) return null;
  if (!parseUuid(projectId)) return null;
  const [project] = await getDb().select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, session.user.organizationId)));
  return project ?? null;
}
