import { migrateDb } from "./client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example for the compose default)");
  process.exit(1);
}

await migrateDb(url);
console.log("migrations applied");
