import { startWorker } from "./queue";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench";

const { stop } = await startWorker({
  databaseUrl,
  handlers: {
    // pipeline handlers land here in later plans: parse, embed,
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
