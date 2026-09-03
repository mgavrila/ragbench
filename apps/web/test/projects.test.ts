import { describe, it, expect, beforeAll } from "vitest";
import { listProjects, createProject } from "@/app/api/projects/route";
import { POST as signup } from "@/app/api/signup/route";

let orgId: string;

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
  const res = await signup(new Request("http://test/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `p${Date.now()}@test.dev`, password: "hunter2xx", organizationName: "P" }),
  }));
  orgId = (await res.json()).organizationId;
});

const session = () => ({ user: { id: "ignored", organizationId: orgId } });

describe("projects api", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await listProjects(null)).status).toBe(401);
  });

  it("creates and lists projects scoped to the org", async () => {
    const create = await createProject(new Request("http://test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Docs corpus" }),
    }), session());
    expect(create.status).toBe(201);

    const list = await listProjects(session());
    const body = await list.json();
    expect(body.projects.map((p: any) => p.name)).toContain("Docs corpus");
  });
});
