import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // The app's tsconfig sets jsx: "preserve" (Next.js does its own JSX transform at build time), but
  // Vite's esbuild transform reads that same setting for test files and, with "preserve", leaves JSX
  // untransformed -- fine until a test imports a .tsx component directly, which then fails to parse.
  // Override just for the test runner.
  oxc: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    // next-auth is pure ESM and imports subpaths of `next` (e.g. "next/server")
    // without an extension; this `next` build has no "exports" map, so Node's
    // native ESM resolver (used for externalized deps) can't auto-resolve it.
    // Inlining routes the import through Vite's resolver instead, which does.
    server: { deps: { inline: ["next-auth"] } },
  },
});
