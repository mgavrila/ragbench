import { redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { projects } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";

export default async function ProjectsPage() {
  const session = await auth();
  const orgId = session?.user?.organizationId;
  if (!orgId) redirect("/login");

  const rows = await getDb().select().from(projects).where(eq(projects.organizationId, orgId));

  async function create(formData: FormData) {
    "use server";
    const s = await auth();
    const org = s?.user?.organizationId;
    if (!org) redirect("/login");
    await getDb().insert(projects).values({ organizationId: org, name: String(formData.get("name")) });
    redirect("/projects");
  }

  return (
    <div>
      <h1>Projects</h1>
      <ul>{rows.map((p) => <li key={p.id}><Link href={`/projects/${p.id}`}>{p.name}</Link></li>)}</ul>
      <form action={create}>
        <input name="name" placeholder="New project name" required />
        <button type="submit">Create</button>
      </form>
    </div>
  );
}
