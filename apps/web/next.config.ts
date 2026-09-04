import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone: a self-contained server bundle with only the node_modules it actually
  // uses (Next traces the dependency graph via `@vercel/nft`), copied into the Docker runner stage
  // instead of the whole monorepo's node_modules. See Dockerfile.
  output: "standalone",
};
export default nextConfig;
