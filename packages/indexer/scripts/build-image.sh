#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
project_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"

. "$script_dir/dev-env.sh"

print_help() {
  echo "Usage: $0 [image-tag]"
  echo
  echo "Build the standalone indexer image from packages/indexer."
  echo "Set DOCKER_BUILD_NETWORK=host only if Docker bridge networking is flaky on your machine."
  echo
  echo "Examples:"
  echo "  $0"
  echo "  $0 nftlox-indexer"
  echo "  DOCKER_BUILD_NETWORK=host $0 nftlox-indexer"
}

case "${1:-}" in
  -h|--help|help)
    print_help
    exit 0
    ;;
esac

image_tag="${1:-nftlox-indexer}"
build_network="${DOCKER_BUILD_NETWORK:-}"

cd "$project_dir"

print_build_hint

set --
if [ -n "$build_network" ]; then
  echo "Using docker build network: $build_network" >&2
  set -- --network "$build_network"
fi

if has_docker_buildx; then
  echo "Using docker buildx for the indexer image." >&2
  exec docker buildx build --load "$@" -t "$image_tag" -f Dockerfile .
fi

echo "Using legacy docker build for the indexer image." >&2
exec docker build "$@" -t "$image_tag" -f Dockerfile .
