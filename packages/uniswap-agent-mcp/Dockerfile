# syntax=docker/dockerfile:1.7
# Uniswap agent MCP server (streamable HTTP on /mcp, GET /health).
# Build from the repo root:  docker build -f packages/uniswap-agent-mcp/Dockerfile -t uniswap-agent-mcp .

ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# --- build -------------------------------------------------------------------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/uniswap-agent-mcp/package.json packages/uniswap-agent-mcp/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter uniswap-agent-mcp...
COPY packages/uniswap-agent-mcp packages/uniswap-agent-mcp
RUN pnpm --filter uniswap-agent-mcp build
# Self-contained production bundle (prod dependencies only).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter uniswap-agent-mcp deploy --prod /out

# --- runtime -----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production PORT=3002
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/packages/uniswap-agent-mcp/dist ./dist
USER node
EXPOSE 3002
CMD ["node", "dist/index.js", "--transport", "http"]
