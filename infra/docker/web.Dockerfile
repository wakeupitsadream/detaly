# syntax=docker/dockerfile:1
# Next.js standalone image for apps/web.
# Build from the repository root:
#   docker build -f infra/docker/web.Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t detaly-web .

ARG NODE_IMAGE=node:22.22-bookworm-slim

# --- base: node + pinned pnpm via corepack ---
FROM ${NODE_IMAGE} AS base
# CI=true: pnpm must not prompt (no TTY in docker build) when re-linking node_modules.
ENV PNPM_HOME=/pnpm \
    CI=true \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# --- fetch: download every package from the lockfile (layer cached until the lock changes) ---
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm config set store-dir /pnpm/store && pnpm fetch --frozen-lockfile

# --- build: offline install of web and its workspace deps, then next build ---
FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@detaly/web..."
RUN pnpm --filter @detaly/web build
# standalone does not include static assets and public/; copy them next to server.js
RUN mkdir -p apps/web/public \
 && test -f apps/web/.next/standalone/apps/web/server.js \
 && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
 && cp -r apps/web/public apps/web/.next/standalone/apps/web/public

# --- runtime ---
FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/wakeupitsadream/detaly" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="detaly-web"
WORKDIR /app
# The server is root-owned and read-only for `node`; only the Next cache (image optimizer,
# fetch cache) is writable, so code execution in web cannot rewrite server.js or chunks.
COPY --from=build /app/apps/web/.next/standalone ./
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
