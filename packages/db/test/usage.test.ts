import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb } from "../src/client";
import { organizations, usageLog } from "../src/schema";
import { makeUsageReporter } from "../src/usage";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";
let ctx: Awaited<ReturnType<typeof createDb>>;
let orgId: string;

beforeAll(async () => {
  await migrateDb(URL);
  ctx = createDb(URL);
  const [org] = await ctx.db.insert(organizations).values({ name: "usage-org" }).returning();
  orgId = org.id;
});
afterAll(async () => { await ctx.pool.end(); });

describe("makeUsageReporter", () => {
  it("logs LLM usage with registry-priced cost", async () => {
    const report = makeUsageReporter(ctx.db, orgId);
    await report({ purpose: "testset", provider: "anthropic", model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const rows = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBeCloseTo(30);
    expect(rows[0].purpose).toBe("testset");
  });

  it("logs embedding usage and zero-cost unknown models", async () => {
    const report = makeUsageReporter(ctx.db, orgId);
    await report({ purpose: "embed", provider: "openai", model: "text-embedding-3-small", inputTokens: 1_000_000, outputTokens: 0 });
    await report({ purpose: "embed", provider: "mock", model: "not-registered", inputTokens: 5, outputTokens: 0 });
    // "constructor" is inherited from Object.prototype, so a bare LLM_MODELS[model] check resolves
    // it to a function and sends it to the pricing math, which throws on the unknown model. The
    // reporter must be unthrowable for ANY model string, so this logs at zero cost like any other
    // unregistered name.
    await report({ purpose: "embed", provider: "mock", model: "constructor", inputTokens: 5, outputTokens: 0 });
    const rows = await ctx.db.select().from(usageLog).where(eq(usageLog.organizationId, orgId));
    const small = rows.find((r) => r.model === "text-embedding-3-small")!;
    const unknown = rows.find((r) => r.model === "not-registered")!;
    const inherited = rows.find((r) => r.model === "constructor")!;
    expect(small.costUsd).toBeCloseTo(0.02);
    expect(unknown.costUsd).toBe(0);
    expect(inherited.costUsd).toBe(0);
  });

  it("resolves without throwing when the insert fails, metering being advisory-only", async () => {
    const poisonedDb = { insert: () => ({ values: () => { throw new Error("connection reset"); } }) };
    const report = makeUsageReporter(poisonedDb as never, orgId);
    await expect(report({
      purpose: "testset", provider: "anthropic", model: "claude-opus-5", inputTokens: 10, outputTokens: 10,
    })).resolves.toBeUndefined();
  });
});
