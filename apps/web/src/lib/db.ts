import { createDb, type Db } from "@ragbench/db";

let cached: { db: Db } | null = null;

export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    cached = { db: createDb(url).db };
  }
  return cached.db;
}
