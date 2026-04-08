#!/bin/sh
set -eu

cd /app

command_name="${1:-start}"

case "$command_name" in
  start)
    shift
    exec bun run src/index.ts "$@"
    ;;
  monolith)
    shift
    exec env INDEXER_ROLE=both bun run src/index.ts "$@"
    ;;
  sync)
    shift
    exec env INDEXER_ROLE=sync bun run src/index.ts "$@"
    ;;
  api)
    shift
    exec env INDEXER_ROLE=api bun run src/index.ts "$@"
    ;;
  healthcheck)
    shift
    exec /app/scripts/docker-healthcheck.sh "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
