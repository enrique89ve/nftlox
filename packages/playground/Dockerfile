FROM oven/bun:1.3.11
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/playground/package.json ./packages/playground/
COPY packages/indexer/package.json ./packages/indexer/
COPY packages/packs-engine/package.json ./packages/packs-engine/
COPY packages/indexer-snapshot/package.json ./packages/indexer-snapshot/

RUN bun install --frozen-lockfile --production --filter nftlox-playground

COPY packages/protocol/ ./packages/protocol/
COPY packages/sdk/ ./packages/sdk/
COPY packages/playground/ ./packages/playground/

RUN chown -R bun:bun /app

USER bun

WORKDIR /app/packages/playground

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD bun -e 'const r = await fetch("http://127.0.0.1:3040/"); process.exit(r.ok ? 0 : 1);'

EXPOSE 3040

CMD ["bun", "run", "src/server.ts"]
