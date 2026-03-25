FROM oven/bun:1.3-debian
WORKDIR /app

# Copy lockfile and package.json files first to cache dependencies
COPY package.json bun.lock ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/indexer/package.json ./packages/indexer/

# Install dependencies
RUN bun install

# Copy the rest of the source code
COPY packages/sdk/ ./packages/sdk/
COPY packages/indexer/ ./packages/indexer/

WORKDIR /app/packages/indexer

ENV NODE_ENV=production
ENV ENABLE_SWAGGER=false

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
	CMD bun -e "const r=await fetch('http://localhost:'+(Bun.env.INDEXER_PORT||'3050')+'/api/health');process.exit(r.ok?0:1)"

EXPOSE 3050

CMD ["bun", "run", "src/index.ts"]
