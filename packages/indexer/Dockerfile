FROM oven/bun:1.3.11

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

# Copy the local manifest and lockfile first for dependency caching.
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile --production

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
