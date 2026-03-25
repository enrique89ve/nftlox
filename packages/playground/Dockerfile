FROM oven/bun:1.3-debian
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/playground/package.json ./packages/playground/

RUN bun install

COPY packages/sdk/ ./packages/sdk/
COPY packages/playground/ ./packages/playground/

WORKDIR /app/packages/playground

ENV NODE_ENV=production

EXPOSE 3040

CMD ["bun", "run", "src/server.ts"]
