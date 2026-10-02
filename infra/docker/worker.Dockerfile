# syntax=docker/dockerfile:1
# apps/worker image. TypeScript runs through tsx (node --import tsx), also in production.
# The same image runs migrations and seeds (packages/db/drizzle and content/legal are inside):
#   docker compose run --rm worker node --import tsx /app/packages/db/src/migrate.ts
# Build from the repository root:
#   docker build -f infra/docker/worker.Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t detaly-worker .

ARG NODE_IMAGE=node:22.22-bookworm-slim

FROM ${NODE_IMAGE} AS base
# CI=true: pnpm must not prompt (no TTY in docker build) when re-linking node_modules.
ENV PNPM_HOME=/pnpm \
    CI=true \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm config set store-dir /pnpm/store && pnpm fetch --frozen-lockfile --prod

# --prod: no devDependencies. tsx is a dependency of @detaly/worker and @detaly/db (not of the
# root), so `--import tsx` must resolve from apps/worker (see WORKDIR below).
# Starts from base and takes only the fetched store: `pnpm fetch` also links every package of
# the lockfile (next, swc, sharp...) into node_modules/.pnpm, which the worker does not need.
FROM base AS prod
COPY --from=fetch /pnpm/store /pnpm/store
RUN pnpm config set store-dir /pnpm/store
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod --filter "@detaly/worker..." \
 && rm -rf apps/web \
 && test -d packages/db/node_modules \
 && test -e apps/worker/node_modules/tsx

FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/wakeupitsadream/detaly" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="detaly-worker"
# Code and node_modules stay root-owned (read-only for the `node` user): code execution in the
# worker (e.g. through SOAP/XML parsing) must not be able to rewrite src/ or dependencies and
# persist until the container is recreated. tsx caches into os.tmpdir(), not into /app.
COPY --from=prod /app /app
# tsx is resolved relative to the working directory for --import.
WORKDIR /app/apps/worker
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
