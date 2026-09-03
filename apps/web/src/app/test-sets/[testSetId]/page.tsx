import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { projects, testSets } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { QuestionsClient } from "./questions-client";

export default async function TestSetPage({ params }: { params: Promise<{ testSetId: string }> }) {
  const { testSetId } = await params;
  const session = await auth();
  if (!session?.user?.organizationId) redirect("/login");

  // Same ownership chain as the API routes under /api/test-sets and /api/questions: this page
  // also lives outside /projects/:projectId, so there is no path segment to run requireProject
  // against -- walk set -> project -> organizationId instead.
  const [row] = await getDb()
    .select({
      id: testSets.id,
      projectId: testSets.projectId,
      name: testSets.name,
      generatorModel: testSets.generatorModel,
      status: testSets.status,
      error: testSets.error,
      questionsTarget: testSets.questionsTarget,
      createdAt: testSets.createdAt,
      organizationId: projects.organizationId,
    })
    .from(testSets)
    .innerJoin(projects, eq(projects.id, testSets.projectId))
    .where(eq(testSets.id, testSetId));

  if (!row || row.organizationId !== session.user.organizationId) notFound();

  return (
    <QuestionsClient
      testSetId={testSetId}
      initialTestSet={{
        id: row.id,
        projectId: row.projectId,
        name: row.name,
        generatorModel: row.generatorModel,
        status: row.status,
        error: row.error,
        questionsTarget: row.questionsTarget,
        createdAt: row.createdAt.toISOString(),
      }}
    />
  );
}
