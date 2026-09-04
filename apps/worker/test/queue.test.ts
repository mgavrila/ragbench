import { describe, it, expect, afterAll } from "vitest";
import { startWorker, enqueue } from "../src/queue";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench_test";

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
    await boss.deleteAllJobs("evaluate-question");
    await boss.deleteAllJobs("serial-probe");
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

  // Each of these handlers parks until the expected number of jobs is in flight at once, so the
  // assertion cannot pass by accident: with a serial worker the barrier is never reached and
  // `peak` stays at 1. The wait is bounded so a genuinely serial worker fails the assertion rather
  // than hanging the suite.
  async function peakConcurrency(queue: string, jobCount: number, expectPeak: number): Promise<number> {
    let inFlight = 0;
    let peak = 0;
    let done = 0;
    const { boss, stop } = await startWorker({
      databaseUrl: URL,
      handlers: {
        [queue]: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          const deadline = Date.now() + 5000;
          while (inFlight < expectPeak && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
          }
          peak = Math.max(peak, inFlight);
          inFlight--;
          done++;
        },
      },
    });
    for (let i = 0; i < jobCount; i++) await enqueue(boss, queue, { i }, `k${i}`);
    const deadline = Date.now() + 30000;
    while (done < jobCount && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await stop();
    return peak;
  }

  // Spec section 6: the worker caps LLM concurrency (default 4, configurable). Evaluating a
  // question is one embed plus up to two LLM calls, so a serial worker turns a 90-job run into 90
  // sequential round trips to a provider that would happily serve several at once.
  it("runs evaluate-question jobs concurrently up to RAGBENCH_EVAL_CONCURRENCY", async () => {
    const previous = process.env.RAGBENCH_EVAL_CONCURRENCY;
    process.env.RAGBENCH_EVAL_CONCURRENCY = "3";
    try {
      expect(await peakConcurrency("evaluate-question", 3, 3)).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.RAGBENCH_EVAL_CONCURRENCY;
      else process.env.RAGBENCH_EVAL_CONCURRENCY = previous;
    }
  });

  // The knob has a ceiling. Past a handful of jobs the limit is the provider's rate limit, which
  // answers extra concurrency with 429s, and each in-flight job also holds a database connection --
  // so an unbounded value would quietly size the pool too. A too-large setting is clamped rather
  // than rejected: it is a throughput knob, not a correctness one.
  it("clamps RAGBENCH_EVAL_CONCURRENCY to the ceiling instead of honouring it", async () => {
    const previous = process.env.RAGBENCH_EVAL_CONCURRENCY;
    process.env.RAGBENCH_EVAL_CONCURRENCY = "50";
    try {
      // 9 jobs against a barrier that only releases at 9: with the requested 50 the peak would be 9,
      // with the ceiling of 8 the barrier times out and the peak stops at 8.
      expect(await peakConcurrency("evaluate-question", 9, 9)).toBe(8);
    } finally {
      if (previous === undefined) delete process.env.RAGBENCH_EVAL_CONCURRENCY;
      else process.env.RAGBENCH_EVAL_CONCURRENCY = previous;
    }
  });

  // Only evaluate-question is uncapped. The rest stay one-at-a-time: chunk and embed rebuild a
  // whole set (two at once on the same set would fight over the same rows), and nothing else has a
  // provider round trip worth parallelising.
  it("keeps every other queue serial", async () => {
    expect(await peakConcurrency("serial-probe", 2, 2)).toBe(1);
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
