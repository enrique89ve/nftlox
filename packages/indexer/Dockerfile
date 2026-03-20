FROM oven/bun:1.3-alpine
WORKDIR /app

# Copy everything (node_modules included via pre-installed host)
COPY package.json ./
COPY node_modules/ node_modules/
COPY packages/sdk/ packages/sdk/
COPY packages/indexer/ packages/indexer/

WORKDIR /app/packages/indexer

ENV NODE_ENV=production
ENV ENABLE_SWAGGER=false

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
	CMD wget -qO- http://localhost:3050/api/health || exit 1

EXPOSE 3050

CMD ["bun", "run", "src/index.ts"]
