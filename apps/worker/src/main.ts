import { migrateDb, uploadsDir } from "@ragbench/db";
import { startWorker } from "./queue";
import { parseHandler } from "./handlers/parse";
import { chunkHandler } from "./handlers/chunk";
import { embedHandler } from "./handlers/embed";
import { generateTestsetHandler } from "./handlers/generate-testset";
import { startRunHandler } from "./handlers/start-run";
import { evaluateQuestionHandler } from "./handlers/evaluate-question";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";

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
    // remaining pipeline handlers land here in later plans:
    // attribute
  },
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
