import pg from "pg";
import { migrateDb } from "./client";

/** Postgres SQLSTATE for `CREATE DATABASE` against a name that already exists. */
const DUPLICATE_DATABASE = "42P04";

/**
 * Prepares the database a test suite runs against: creates it if it does not exist yet, then
 * migrates it.
 *
 * The suites default to a database of their own (`ragbench_test`) rather than the compose dev
 * database. Sharing one meant a `pnpm dev` worker polling the same pg-boss queues stole the jobs
 * the queue tests were waiting on, and dev smoke data leaked into eval fixtures -- failures that
 * looked like product bugs and were not. Creating it here rather than in compose keeps a fresh
 * checkout to one command: `docker compose up` plus `pnpm test`.
 *
 * CREATE DATABASE cannot run inside a transaction, and cannot run against the database it is
 * creating, so it goes through a short-lived connection to the cluster's `postgres` maintenance
 * database. A concurrent suite winning the race raises duplicate_database, which is the success
 * case here, not an error. The extension the schema needs (pgvector) is created by migration 0000
 * itself, so a database created from template0/template1 needs nothing else first.
 */
export async function setupTestDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!name) throw new Error(`test database url has no database name: ${url}`);

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    // A database name is an identifier, not a value, so it cannot be parameterised. It comes from
    // our own environment rather than a request, and is double-quoted (with embedded quotes
    // doubled) so it stays exactly one identifier whatever it contains.
    await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } catch (err) {
    if ((err as { code?: string }).code !== DUPLICATE_DATABASE) throw err;
  } finally {
    await client.end();
  }

  await migrateDb(url);
}
