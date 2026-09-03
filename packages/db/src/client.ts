import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "url";
import path from "path";
import * as schema from "./schema";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function migrateDb(url: string) {
  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

export type Db = ReturnType<typeof createDb>["db"];
