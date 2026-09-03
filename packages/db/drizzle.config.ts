import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  // Only drizzle-kit's DB-touching commands (push, studio, introspect) read this; `generate` is
  // offline, so the compose default keeps it usable without a .env.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://ragbench:ragbench@localhost:5433/ragbench",
  },
});
