#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$script_dir/dev-env.sh"

print_help() {
  echo "Usage: $0 <dokploy|server|dev|external> [docker-compose args...]"
  echo
  echo "Modes:"
  echo "  dokploy  Full Docker deployment behind an external platform proxy"
  echo "           Uses DATABASE_MODE from .env to decide internal vs external DB"
  echo "  server   Same compose, but also enables the bundled Nginx profile"
  echo "  dev      PostgreSQL in Docker only; run the indexer on the host"
  echo "  external Backward-compatible alias for dokploy with DATABASE_MODE=external"
  echo
  echo "Examples:"
  echo "  $0 dokploy up -d"
  echo "  $0 server up -d"
  echo "  $0 dev up -d"
  echo "  $0 external up -d"
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

load_compose_env() {
  if [ ! -f .env ]; then
    return 0
  fi

  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
}

resolve_database_mode() {
  mode="${DATABASE_MODE:-auto}"

  case "$mode" in
    auto)
      if [ -n "${DATABASE_URL:-}" ]; then
        echo "external"
      else
        echo "internal"
      fi
      ;;
    internal|external)
      echo "$mode"
      ;;
    *)
      echo "Invalid DATABASE_MODE: $mode" >&2
      exit 1
      ;;
  esac
}

set_compose_profiles() {
  deployment_target="$1"
  effective_database_mode="$2"
  profiles=""

  if [ "$effective_database_mode" = "internal" ]; then
    profiles="internal-db"
  fi

  if [ "$deployment_target" = "server" ]; then
    if [ -n "$profiles" ]; then
      profiles="$profiles,server"
    else
      profiles="server"
    fi
  fi

  if [ -n "$profiles" ]; then
    export COMPOSE_PROFILES="$profiles"
  else
    unset COMPOSE_PROFILES 2>/dev/null || true
  fi
}

run_compose() {
  force_external_mode=false
  if [ "$deployment_mode" = "external" ]; then
    force_external_mode=true
    deployment_mode="dokploy"
  fi

  load_compose_env

  if [ "$force_external_mode" = "true" ]; then
    export DATABASE_MODE=external
  fi

  case "$deployment_mode" in
    dokploy)
      effective_database_mode="$(resolve_database_mode)"
      if [ "$effective_database_mode" = "external" ] && [ -z "${DATABASE_URL:-}" ]; then
        echo "DATABASE_MODE=external requires DATABASE_URL" >&2
        exit 1
      fi
      set_compose_profiles "dokploy" "$effective_database_mode"
      if [ -n "${DOCKER_SUBNET:-}" ]; then
        exec docker compose -f docker-compose.yml -f docker-compose.network.yml "$@"
      fi
      exec docker compose -f docker-compose.yml "$@"
      ;;
    server|standalone)
      effective_database_mode="$(resolve_database_mode)"
      if [ "$effective_database_mode" = "external" ] && [ -z "${DATABASE_URL:-}" ]; then
        echo "DATABASE_MODE=external requires DATABASE_URL" >&2
        exit 1
      fi
      set_compose_profiles "server" "$effective_database_mode"
      if [ -n "${DOCKER_SUBNET:-}" ]; then
        exec docker compose -f docker-compose.yml -f docker-compose.network.yml "$@"
      fi
      exec docker compose -f docker-compose.yml "$@"
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
