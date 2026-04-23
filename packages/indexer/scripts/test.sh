#!/usr/bin/env bash
# Canonical test runner — use this instead of plain `bun test`.
#
# Bun 1.x runs all test files in one shared process when invoked with
# `bun test`. Two problems arise in a shared process:
#
#   1. mock.module() calls are global and bleed into every subsequent file.
#      sync-engine.test.ts mocks @/db/client.ts at module level; any file
#      that loads after it receives the mock instead of the real DB pool.
#
#   2. beforeAll/beforeEach cleaners in one file race with live queries
#      from another file, corrupting shared PostgreSQL tables.
#
# This script gives each file its own `bun` subprocess — fresh module
# registry, clean mock state, and an isolated DB connection pool.
#
# Usage:
#   bun run test                   # run all test files
#   bun run test:filter <substring> # run only paths containing <substring>
set -u

cd "$(dirname "$0")/.."

FILTER="${1:-}"
PASS=0
FAIL=0
FAILED_FILES=""

FILES=$(find src/__tests__ -name '*.test.ts' | sort)

for file in $FILES; do
	if [ -n "$FILTER" ] && ! printf '%s' "$file" | grep -q "$FILTER"; then
		continue
	fi
	printf '\n── %s ──\n' "$file"
	if bun test "$file"; then
		PASS=$((PASS + 1))
	else
		FAIL=$((FAIL + 1))
		FAILED_FILES="$FAILED_FILES\n  $file"
	fi
done

printf '\n═══ Summary ═══\n'
printf 'Passed files: %d\n' "$PASS"
printf 'Failed files: %d\n' "$FAIL"
if [ "$FAIL" -gt 0 ]; then
	printf 'Failures:%b\n' "$FAILED_FILES"
	exit 1
fi
