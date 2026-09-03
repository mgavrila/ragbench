import { describe, it, expect, afterAll } from "vitest";
import { startWorker, enqueue } from "../src/queue";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";

describe("worker queue", () => {
  it("processes an enqueued job", async () => {
    const seen: string[] = [];
    const { boss, stop } = await startWorker({
      databaseUrl: URL,
      handlers: {
        echo: async (data: { msg: string }) => { seen.push(data.msg); },
      },
    });
    await enqueue(boss, "echo", { msg: "hello" });
    const deadline = Date.now() + 20000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await stop();
    expect(seen).toEqual(["hello"]);
  });

  it("deduplicates on singletonKey", async () => {
    const { boss, stop } = await startWorker({ databaseUrl: URL, handlers: { noop: async () => {} } });
    const first = await enqueue(boss, "noop", { a: 1 }, "same-key");
    const second = await enqueue(boss, "noop", { a: 1 }, "same-key");
    await stop();
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // pg-boss returns null for a rejected duplicate
  });
});
