import { describe, it, expect, vi } from "vitest";

// Own file on purpose: getDb() caches its pool at module scope, so pointing the health check at a
// dead database has to happen before anything imports the route.
process.env.DATABASE_URL = "postgres://ragbench:ragbench@localhost:1/nope";

describe("GET /api/health", () => {
  it("reports 503 and logs when the DB is unreachable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/health/route");

    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false });
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });
});
