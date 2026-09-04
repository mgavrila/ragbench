import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { evalRuns, projects } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { parseUuid } from "@/lib/params";
import { AppShell } from "@/components/app-shell";
import { RunClient } from "./run-client";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const session = await auth();
  if (!session?.user?.organizationId) redirect("/login");
  // Same guard as the API routes: a malformed id must render the not-found page, not a 500 from an
  // invalid-uuid query (see @/lib/params).
  if (!parseUuid(runId)) notFound();

  // Same ownership chain as the run APIs: this page lives outside /projects/:projectId, so there
  // is no path segment to run requireProject against -- walk run -> project -> organizationId
  // instead, matching test-sets/[testSetId]/page.tsx's pattern. The rest of the run detail (grid,
  // aggregates) is fetched client-side by RunClient from the same endpoint the poll re-hits, so
  // this check only decides whether the page exists at all.
  const [row] = await getDb()
    .select({ id: evalRuns.id, organizationId: projects.organizationId })
    .from(evalRuns)
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(eq(evalRuns.id, runId));

  if (!row || row.organizationId !== session.user.organizationId) notFound();

  // `wide`: the question grid gains a column per config, so this page gets the wider content
  // column while every other page keeps the reading-width default.
  return (
    <AppShell wide>
      <RunClient runId={runId} />
    </AppShell>
  );
}
