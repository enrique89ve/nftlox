#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$script_dir/dev-env.sh"

print_help() {
  echo "Usage: $0 <dokploy|server|dev> [docker-compose args...]"
  echo
  echo "Modes:"
  echo "  dokploy  Full Docker deployment behind an external platform proxy"
  echo "  server   Full Docker deployment with the bundled Nginx overlay"
  echo "  dev      PostgreSQL in Docker only; run the indexer on the host"
  echo
  echo "Examples:"
  echo "  $0 dokploy up -d"
  echo "  $0 server up -d"
  echo "  $0 dev up -d"
  echo "  DOCKER_SUBNET=172.28.10.0/24 $0 dokploy up -d"
}

deployment_mode="${1:-}"
if [ -z "$deployment_mode" ]; then
  print_help
  exit 1
fi
shift

if [ "$deployment_mode" = "dev" ]; then
  print_dev_mode_note
fi

if [ "$#" -eq 0 ]; then
  set -- up -d
fi

run_compose() {
  case "$deployment_mode" in
    dokploy)
      if [ -n "${DOCKER_SUBNET:-}" ]; then
        exec docker compose -f docker-compose.yml -f docker-compose.network.yml "$@"
      fi
      exec docker compose -f docker-compose.yml "$@"
      ;;
    server|standalone)
      if [ -n "${DOCKER_SUBNET:-}" ]; then
        exec docker compose -f docker-compose.yml -f docker-compose.nginx.yml -f docker-compose.network.yml "$@"
      fi
      exec docker compose -f docker-compose.yml -f docker-compose.nginx.yml "$@"
      ;;
    dev)
      if [ -n "${DOCKER_SUBNET:-}" ]; then
        exec docker compose -f docker-compose.dev.yml -f docker-compose.network.yml "$@"
      fi
      exec docker compose -f docker-compose.dev.yml "$@"
      ;;
    -h|--help|help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown deployment mode: $deployment_mode" >&2
      print_help
      exit 1
      ;;
  esac
}

run_compose "$@"
