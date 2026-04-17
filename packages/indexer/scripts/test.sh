#!/usr/bin/env bash
# Runs each test file in its own Bun process to bypass the cross-file
# `mock.module()` contamination (mocks registered in one file leak into
# the next when run in a shared process).
#
# Usage:
#   ./scripts/test.sh              # run all test files
#   ./scripts/test.sh <substring>  # run only paths containing <substring>
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
