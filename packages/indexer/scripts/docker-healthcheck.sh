#!/bin/sh
set -eu

health_port="${HEALTH_PORT:-0}"
indexer_port="${INDEXER_PORT:-3050}"

case "$health_port" in
  ''|0)
    health_url="http://127.0.0.1:${indexer_port}/api/health"
    ;;
  *)
    health_url="http://127.0.0.1:${health_port}/live"
    ;;
esac

exec bun -e 'const url = process.argv[1]; const response = await fetch(url); process.exit(response.ok ? 0 : 1);' "$health_url"
