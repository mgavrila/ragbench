import { describe, it, expect, beforeAll } from "vitest";
import { POST as signup } from "@/app/api/signup/route";
import { verifyCredentials } from "@/auth-core";

beforeAll(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
});

function req(body: unknown) {
  return new Request("http://test/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("signup + credentials", () => {
  const email = `u${Date.now()}@test.dev`;

  it("creates org and user", async () => {
    const res = await signup(req({ email, password: "hunter2xx", organizationName: "Acme" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userId).toBeTruthy();
    expect(body.organizationId).toBeTruthy();
  });

  it("rejects duplicate email with 409", async () => {
    const res = await signup(req({ email, password: "hunter2xx", organizationName: "Acme" }));
    expect(res.status).toBe(409);
  });

  it("rejects invalid payloads with 400", async () => {
    const res = await signup(req({ email: "not-an-email", password: "x" }));
    expect(res.status).toBe(400);
  });

  it("verifies correct credentials and rejects wrong ones", async () => {
    expect(await verifyCredentials(email, "hunter2xx")).toMatchObject({
      organizationId: expect.any(String),
    });
    expect(await verifyCredentials(email, "wrong")).toBeNull();
    expect(await verifyCredentials("nobody@test.dev", "x")).toBeNull();
  });
});
