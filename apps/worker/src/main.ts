import { migrateDb, uploadsDir } from "@ragbench/db";
import { startWorker } from "./queue";
import { parseHandler } from "./handlers/parse";
import { chunkHandler } from "./handlers/chunk";
import { embedHandler } from "./handlers/embed";
import { generateTestsetHandler } from "./handlers/generate-testset";
import { startRunHandler } from "./handlers/start-run";
import { evaluateQuestionHandler } from "./handlers/evaluate-question";
import { attributeHandler } from "./handlers/attribute";
import { reconcileHandler } from "./handlers/reconcile";

/**
 * Dev convenience only, matching apps/web/src/lib/db.ts: an unset DATABASE_URL falls back to the
 * compose connection string so `pnpm dev` works on a fresh checkout with no .env at all. Gated to
 * non-production so a real deployment with a missing DATABASE_URL fails loudly at boot instead of
 * silently migrating and polling localhost:5433 -- a database that in production is either nothing
 * (connection refused) or, worse, someone else's local Postgres on the same port.
 */
const databaseUrl =
  process.env.DATABASE_URL ??
  (process.env.NODE_ENV !== "production" ? "postgres://ragbench:ragbench@localhost:5433/ragbench" : undefined);
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set (see .env.example for the compose default)");
}

// The worker owns schema migration so a fresh database heals itself on boot. It is the one
// long-lived process guaranteed to run, and boss.start() below already bootstraps pg-boss's own
// schema the same way -- doing ours here keeps the two in step without a manual `db:migrate`.
await migrateDb(databaseUrl);
console.log("ragbench migrations applied");

const { stop } = await startWorker({
  databaseUrl,
  handlers: {
    parse: parseHandler,
    chunk: chunkHandler,
    embed: embedHandler,
    "generate-testset": generateTestsetHandler,
    "start-run": startRunHandler,
    "evaluate-question": evaluateQuestionHandler,
    // Stays at the default localConcurrency of 1 (see queue.ts): diagnose is user-paced, one click
    // per result, and every job is keyed by its resultId, so there is nothing to fan out.
    attribute: attributeHandler,
    reconcile: reconcileHandler,
  },
  // Every 5 minutes: catches a run/chunk-set/document left behind by a worker that died mid-job
  // (the queue's job stays created/retry/active forever once nothing is left to pick it up again
  // under pg-boss's normal delivery). See handlers/reconcile.ts for the stuck-detection windows.
  schedules: [{ name: "reconcile", cron: "*/5 * * * *" }],
});
// The web app writes uploads here and this process reads them; if the two resolve
// RAGBENCH_UPLOADS_DIR differently every parse job fails with ENOENT, so print what we resolved.
console.log(`ragbench worker started (uploads dir: ${uploadsDir()})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`received ${sig}, draining...`);
    await stop();
    process.exit(0);
  });
}
