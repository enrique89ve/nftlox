# syntax=docker/dockerfile:1.7
# Non-Dokploy image: runs the indexer from source via `bun run` (no bundling).
# Build from the monorepo root so workspace links resolve against bun.lock.
FROM oven/bun:1.3.11-slim

ARG BUILD_TIME
ARG GIT_COMMIT_SHA
ARG GIT_CURRENT_BRANCH

LABEL org.opencontainers.image.title="NFTLox Indexer"
LABEL org.opencontainers.image.description="Hive blockchain NFT indexer and API"
LABEL org.opencontainers.image.source="https://github.com/nftlox/nftlox"
LABEL org.opencontainers.image.created="${BUILD_TIME}"
LABEL org.opencontainers.image.revision="${GIT_COMMIT_SHA}"
LABEL io.nftlox.image.branch="${GIT_CURRENT_BRANCH}"

WORKDIR /app

# Manifest-first layering: copy lockfile + every workspace manifest so
# `bun install` caches until dependencies actually change. Source code
# goes in a later layer.
COPY package.json bun.lock ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/indexer/package.json ./packages/indexer/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/packs-engine/package.json ./packages/packs-engine/
COPY packages/playground/package.json ./packages/playground/
COPY packages/indexer-snapshot/package.json ./packages/indexer-snapshot/

# BuildKit cache mount keeps bun's install cache warm across rebuilds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile --production

COPY . .

RUN chmod +x /app/scripts/*.sh && \
	chown -R bun:bun /app

USER bun

ENV NODE_ENV=production
ENV ENABLE_SWAGGER=false

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
	CMD ["/app/scripts/docker-healthcheck.sh"]

EXPOSE 3050

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["start"]
