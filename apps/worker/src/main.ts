import { migrateDb } from "@ragbench/db";
import { startWorker } from "./queue";
import { parseHandler } from "./handlers/parse";
import { chunkHandler } from "./handlers/chunk";
import { embedHandler } from "./handlers/embed";

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
    // remaining pipeline handlers land here in later plans:
    // generate-testset, evaluate-question, attribute
  },
});
console.log("ragbench worker started");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`received ${sig}, draining...`);
    await stop();
    process.exit(0);
  });
}
