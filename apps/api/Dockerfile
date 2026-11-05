# syntax=docker/dockerfile:1.7
# One image for every backend process. Select with PROCESS_TYPE=server|worker|bot.
# Build from the repo root:  docker build -f apps/api/Dockerfile -t warden-api .

ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# --- build -------------------------------------------------------------------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/uniswap-agent-mcp/package.json packages/uniswap-agent-mcp/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @warden/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @warden/shared build && pnpm --filter @warden/api build
# Self-contained production bundle of the api package (+ workspace deps, prod only).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @warden/api deploy --prod /out \
  && cd /out && npx --no-install prisma generate --schema prisma/schema.prisma

# --- runtime -----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production PROCESS_TYPE=server PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 3001
# Migrations run as a separate release step:  npx prisma migrate deploy
CMD ["node", "dist/main.js"]
