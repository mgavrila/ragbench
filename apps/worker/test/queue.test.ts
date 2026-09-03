import { describe, it, expect, afterAll } from "vitest";
import { startWorker, enqueue } from "../src/queue";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";

describe("worker queue", () => {
  // Both tests below leave rows behind in the "echo"/"noop" queues: test 1 reaches a terminal
  // state normally, but test 2 never waits for its "noop" job to finish before stop(). Under the
  // "exclusive" queue policy (see queue.ts), a leftover created/active row would collide with a
  // fresh singletonKey send on the NEXT run against this same long-lived container, making
  // `first` unexpectedly null. Clear both test queues so repeated runs stay deterministic.
  afterAll(async () => {
    const { boss, stop } = await startWorker({ databaseUrl: URL, handlers: {} });
    await boss.deleteAllJobs("echo");
    await boss.deleteAllJobs("noop");
    await boss.deleteAllJobs("fanout");
    await stop();
  });

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

  // The counterpart to the dedupe test below, and the behaviour every fan-out stage depends on:
  // "exclusive" serializes jobs that share a singletonKey, so distinct keys on one queue name
  // must all be accepted and all run.
  it("runs every job when the singletonKeys differ", async () => {
    const seen: string[] = [];
    const { boss, stop } = await startWorker({
      databaseUrl: URL,
      handlers: {
        fanout: async (data: { id: string }) => { seen.push(data.id); },
      },
    });
    for (const id of ["a", "b", "c"]) await enqueue(boss, "fanout", { id }, id);
    const deadline = Date.now() + 20000;
    while (seen.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await stop();
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
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
