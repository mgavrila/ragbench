import { redirect } from "next/navigation";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { projects } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { cls } from "@/lib/ui";

export default async function ProjectsPage() {
  const session = await auth();
  const orgId = session?.user?.organizationId;
  if (!orgId) redirect("/login");

  const rows = await getDb()
    .select()
    .from(projects)
    .where(eq(projects.organizationId, orgId))
    .orderBy(desc(projects.createdAt));

  async function create(formData: FormData) {
    "use server";
    const s = await auth();
    const org = s?.user?.organizationId;
    if (!org) redirect("/login");
    await getDb().insert(projects).values({ organizationId: org, name: String(formData.get("name")) });
    redirect("/projects");
  }

  return (
    <AppShell crumbs={[{ href: "/projects", label: "Projects" }]}>
      <PageHeader
        title="Projects"
        meta={`${rows.length} project${rows.length === 1 ? "" : "s"} in your organization`}
      />

      <section className={cls.section}>
        {rows.length === 0 ? (
          <EmptyState
            title="No projects yet"
            hint="A project holds one corpus, its test sets, and every run you compare against them. Create the first one below."
          />
        ) : (
          <div className={cls.tableWrap}>
            <table className={cls.table}>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/projects/${p.id}`}>{p.name}</Link>
                    </td>
                    <td className={cls.muted}>{p.createdAt.toISOString().slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={cls.section}>
        <form action={create} className={cls.form}>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>New project</span>
            <input className={cls.input} name="name" placeholder="Support docs" required />
          </label>
          <button type="submit" className={cls.btnPrimary}>
            Create project
          </button>
        </form>
      </section>
    </AppShell>
  );
}
