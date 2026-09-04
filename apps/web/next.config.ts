import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone: a self-contained server bundle with only the node_modules it actually
  // uses (Next traces the dependency graph via `@vercel/nft`), copied into the Docker runner stage
  // instead of the whole monorepo's node_modules. See Dockerfile.
  output: "standalone",
  // The dev-only route indicator floats over the bottom-left of every page, which puts a black
  // badge into the README's screenshots (the e2e suite captures them against `next dev`). Compile
  // and runtime errors are still surfaced with this off.
  devIndicators: false,
};
export default nextConfig;
