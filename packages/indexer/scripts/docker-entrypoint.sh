#!/bin/sh
set -eu

cd /app

# Production images set INDEXER_ENTRY=dist/indexer.js (bundled, protocol
# inlined). Dev / compose images leave it unset and run TS source directly.
entry="${INDEXER_ENTRY:-src/index.ts}"

command_name="${1:-start}"

case "$command_name" in
  start)
    shift
    exec bun run "$entry" "$@"
    ;;
  monolith)
    shift
    exec env INDEXER_ROLE=both bun run "$entry" "$@"
    ;;
  sync)
    shift
    exec env INDEXER_ROLE=sync bun run "$entry" "$@"
    ;;
  api)
    shift
    exec env INDEXER_ROLE=api bun run "$entry" "$@"
    ;;
  healthcheck)
    shift
    exec /app/scripts/docker-healthcheck.sh "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
