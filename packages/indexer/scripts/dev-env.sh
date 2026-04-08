#!/bin/sh
set -eu

is_wsl() {
  if [ -n "${WSL_DISTRO_NAME:-}" ]; then
    return 0
  fi

  if grep -qi microsoft /proc/version 2>/dev/null; then
    return 0
  fi

  return 1
}

is_windows_mount() {
  case "$(pwd)" in
    /mnt/*) return 0 ;;
    *) return 1 ;;
  esac
}

has_docker_buildx() {
  docker buildx version >/dev/null 2>&1
}

print_wsl_note() {
  if ! is_wsl; then
    return 0
  fi

  echo "WSL detected." >&2

  if is_windows_mount; then
    echo "This repo is under /mnt/*, which is usually much slower for Docker and Bun." >&2
    echo "Prefer cloning into the Linux filesystem, for example under ~/projects/." >&2
  fi

  if ! has_docker_buildx; then
    echo "Docker buildx is not available. Docker will use the legacy builder, which is usually slower." >&2
  fi
}

print_dev_mode_note() {
  echo "Dev mode starts PostgreSQL in Docker only." >&2
  echo "Run the indexer on the host with: bun run dev:indexer" >&2

  if is_wsl; then
    print_wsl_note
    echo "If Docker image builds are slow on WSL, prefer host-run dev mode for daily work." >&2
  fi
}

print_build_hint() {
  print_wsl_note

  if is_wsl; then
    echo "If the build stalls at bun install, retry with DOCKER_BUILD_NETWORK=host." >&2
  fi
}
