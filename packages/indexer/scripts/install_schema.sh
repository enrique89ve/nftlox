#!/bin/bash
set -e

SCRIPTPATH="$(cd -- "$(dirname "$0")" >/dev/null 2>&1 || exit 1; pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPTPATH/.." && pwd)"

# Load environment
if [ -f "$PROJECT_ROOT/.env" ]; then
	source "$PROJECT_ROOT/.env"
fi

: "${DATABASE_URL:=postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer}"
export DATABASE_URL

echo "Installing schema baseline..."

SCHEMA_SQL="$PROJECT_ROOT/src/db/schema.sql"
if [ ! -f "$SCHEMA_SQL" ]; then
	echo "ERROR: schema.sql not found at $SCHEMA_SQL"
	exit 1
fi

echo "  → Applying schema.sql..."
cd "$PROJECT_ROOT"
bun run src/run-migrations.ts

echo "✓ Schema installation complete"
