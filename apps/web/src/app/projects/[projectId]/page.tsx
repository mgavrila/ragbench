import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import { CorpusClient } from "./corpus-client";
import { TestSetsClient } from "./test-sets-client";
import { EvalClient } from "./eval-client";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const session = await auth();
  if (!session?.user?.organizationId) redirect("/login");

  const project = await requireProject(projectId, session);
  if (!project) notFound();

  return (
    <div>
      <h1>{project.name}</h1>
      <CorpusClient projectId={projectId} />
      <TestSetsClient projectId={projectId} />
      <EvalClient projectId={projectId} />
    </div>
  );
}
