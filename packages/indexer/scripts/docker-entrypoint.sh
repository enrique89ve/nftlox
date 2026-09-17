#!/bin/sh
set -eu

if [ -d /app/packages/indexer ]; then
  cd /app/packages/indexer
  script_root=/app/packages/indexer/scripts
else
  cd /app
  script_root=/app/scripts
fi

# Production images set INDEXER_ENTRY to the bundled entrypoint. The standard
# image runs the workspace source from the indexer package directory.
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
    exec "$script_root/docker-healthcheck.sh" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
