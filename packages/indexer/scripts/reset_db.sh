#!/bin/bash
set -e

SCRIPTPATH="$(cd -- "$(dirname "$0")" >/dev/null 2>&1 || exit 1; pwd -P)"

echo "=== NFTLox Database Reset ==="
echo ""

# Uninstall (with confirmation)
"$SCRIPTPATH/uninstall_schema.sh"

echo ""
echo "=== Installing fresh schema ==="

# Install
"$SCRIPTPATH/install_schema.sh"

echo ""
echo "✓ Database reset complete"
