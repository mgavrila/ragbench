import { describe, it, expect, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { POST as signup } from "@/app/api/signup/route";
import SignupPage from "@/app/signup/page";

function req(body: unknown) {
  return new Request("http://test/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("DISABLE_SIGNUP", () => {
  // Save/restore rather than delete: matches queue.test.ts's pattern for RAGBENCH_EVAL_CONCURRENCY
  // (see apps/worker/test/queue.test.ts) so a real value set in the environment this suite runs
  // under survives the suite instead of being unconditionally wiped.
  const original = process.env.DISABLE_SIGNUP;
  afterEach(() => {
    if (original === undefined) delete process.env.DISABLE_SIGNUP;
    else process.env.DISABLE_SIGNUP = original;
  });

  describe("POST /api/signup", () => {
    it("403s before any db work when DISABLE_SIGNUP=1", async () => {
      process.env.DISABLE_SIGNUP = "1";
      // An organizationName this long would fail validation if the route reached registerUser, so a
      // 403 here proves the check runs before that -- not just that some 4xx came back.
      const res = await signup(req({ email: "x@test.dev", password: "hunter2xx", organizationName: "Acme" }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "signup is disabled" });
    });

    it("proceeds normally when DISABLE_SIGNUP is unset", async () => {
      const res = await signup(req({ email: "not-an-email", password: "x" }));
      // Reaches normal validation (400) rather than the 403 the toggle would produce.
      expect(res.status).toBe(400);
    });
  });

  describe("signup page", () => {
    it("hides the form and explains why when DISABLE_SIGNUP=1", async () => {
      process.env.DISABLE_SIGNUP = "1";
      const el = await SignupPage({ searchParams: Promise.resolve({}) });
      const html = renderToStaticMarkup(el);
      expect(html).toContain("Signups are disabled");
      expect(html).not.toContain("<form");
    });

    it("shows the form when DISABLE_SIGNUP is unset", async () => {
      const el = await SignupPage({ searchParams: Promise.resolve({}) });
      const html = renderToStaticMarkup(el);
      expect(html).toContain("<form");
      expect(html).not.toContain("Signups are disabled");
    });
  });
});
