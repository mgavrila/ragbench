import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
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
