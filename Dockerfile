# syntax=docker/dockerfile:1
#
# One image, two processes (see docker-compose.prod.yml): `node apps/web/server.js` for the web
# app, `node apps/worker/src/main.ts` (via tsx) for the worker. They need very different things at
# runtime -- Next's `output: "standalone"` (apps/web/next.config.ts) already produces a
# self-contained, pruned tree for the web app, so it is copied in wholesale. The worker has no
# such build step: @ragbench/db and @ragbench/core ship their TypeScript source directly as their
# package "main" (see packages/db/package.json, packages/core/package.json) with no compiled
# `dist`, and packages/db's own `migrate` script is already `tsx src/migrate.ts` (see its
# package.json) -- so the worker and a manual `pnpm db:migrate` both need a TS-executing runtime in
# the image regardless of what the worker's own entrypoint does. Rather than add a second build
# pipeline (bundle the worker with esbuild, recompile packages/db and packages/core, repoint their
# "main") on top of the one Next already needs, this image runs the worker the same way `pnpm dev`
# already does: through tsx, promoted from devDependencies to a real dependency of apps/worker and
# packages/db (see those package.json files) so it survives a `--prod` install.
#
# Trade-off, made explicit: tsx (and its esbuild) end up in the production image and every worker
# process pays a one-time JIT-transpile per file at startup (not per job -- negligible for a
# long-lived process). What's bought in return is a single execution model across dev and prod (no
# "works with tsx locally, breaks under the bundle in prod" class of bug) and zero extra build
# tooling for two packages that were never meant to ship compiled.

# ---- deps: resolve the full workspace graph once (dev deps included, needed to build web) ----
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile

# ---- build: compile the web app to its standalone output ----
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY . .
# AUTH_SECRET is read at import time by apps/web/src/auth.ts (next-auth config), which route
# manifests touch during the build's page-data collection -- a real secret is not needed to build,
# only a defined one. The deployed container gets its real value from the environment (see
# docker-compose.prod.yml); this placeholder never leaves the build stage.
RUN AUTH_SECRET=build-time-placeholder pnpm --filter @ragbench/web build

# ---- prod-deps: production-only install for the runner (no devDependencies) ----
FROM node:22-alpine AS prod-deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile --prod

# ---- runner: minimal final image ----
FROM node:22-alpine AS runner
# wget is what HEALTHCHECK below uses to hit /api/health; alpine's base image doesn't include it.
# corepack is kept only so `pnpm db:migrate` works as a manual escape hatch inside the container
# (see the header comment) -- neither the web nor the worker command below invokes pnpm itself.
RUN apk add --no-cache wget && corepack enable
WORKDIR /app
ENV NODE_ENV=production

# Web: output:"standalone" already prunes to exactly the node_modules this app uses, so it is
# copied in as one self-contained tree under web/ rather than merged into a shared node_modules --
# merging would risk a version this app didn't ask for winning if the worker's tree below happened
# to overlap. There is no apps/web/public directory yet (see .dockerignore); add a COPY for it here
# if one is introduced.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./web
COPY --from=build --chown=node:node /app/apps/web/.next/static ./web/apps/web/.next/static

# Worker + db + core: run from TypeScript source via tsx (see header comment). Only the files each
# actually needs at runtime -- not test/, not devDependency-only tooling like drizzle-kit.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/core/node_modules ./packages/core/node_modules
COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node apps/worker/package.json apps/worker/package.json
COPY --chown=node:node apps/worker/src apps/worker/src
COPY --chown=node:node packages/db/package.json packages/db/package.json
COPY --chown=node:node packages/db/src packages/db/src
COPY --chown=node:node packages/db/migrations packages/db/migrations
COPY --chown=node:node packages/core/package.json packages/core/package.json
COPY --chown=node:node packages/core/src packages/core/src

# Non-root: the `node` user/group ship built into the base image (uid/gid 1000).
USER node

EXPOSE 3000
# docker-compose.prod.yml overrides `command:` per service (web vs worker); this default is the
# web app, matched by the healthcheck below.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/health || exit 1

CMD ["node", "web/apps/web/server.js"]
