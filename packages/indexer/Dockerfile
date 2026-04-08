FROM oven/bun:1.3.11
WORKDIR /app

# Copy the local manifest and lockfile first for dependency caching.
# The image is built from the package directory itself.
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile --production

COPY . .

RUN chmod +x /app/scripts/*.sh

ENV NODE_ENV=production
ENV ENABLE_SWAGGER=false

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
	CMD ["/app/scripts/docker-healthcheck.sh"]

EXPOSE 3050

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["start"]
