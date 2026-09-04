import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
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
    <AppShell>
      <PageHeader
        eyebrow="Project"
        title={project.name}
        meta="Upload a corpus, chunk and embed it, generate a test set, then run configs against it."
      />
      <CorpusClient projectId={projectId} />
      <TestSetsClient projectId={projectId} />
      <EvalClient projectId={projectId} />
    </AppShell>
  );
}
