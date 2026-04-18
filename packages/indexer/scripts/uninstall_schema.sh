#!/bin/bash
set -e

SCRIPTPATH="$(cd -- "$(dirname "$0")" >/dev/null 2>&1 || exit 1; pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPTPATH/.." && pwd)"

# Load environment
if [ -f "$PROJECT_ROOT/.env" ]; then
	source "$PROJECT_ROOT/.env"
fi

: "${DATABASE_URL:=postgresql://postgres:postgres@localhost:5432/nftlox}"

echo "WARNING: This will drop ALL data in the nftlox database."
echo "DATABASE_URL: $DATABASE_URL"
read -p "Are you sure? (type 'yes' to confirm): " confirm

if [ "$confirm" != "yes" ]; then
	echo "Cancelled."
	exit 1
fi

echo "Dropping schema..."
psql "$DATABASE_URL" -c "DROP SCHEMA IF EXISTS public CASCADE;" 2>/dev/null || true
psql "$DATABASE_URL" -c "CREATE SCHEMA public;" 2>/dev/null || true

echo "✓ Schema dropped"
