#!/bin/bash
# Helper para PostgreSQL sin docker compose

CONTAINER_NAME="nftlox-postgres"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_PATH="$SCRIPT_DIR/src/db/schema.sql"

case "${1:-up}" in
	up)
		if docker ps -q -f name=$CONTAINER_NAME | grep -q .; then
			echo "PostgreSQL already running"
		else
			docker rm -f $CONTAINER_NAME 2>/dev/null
			docker run -d \
				--name $CONTAINER_NAME \
				-e POSTGRES_DB=nftlox_indexer \
				-e POSTGRES_USER=nftlox \
				-e POSTGRES_PASSWORD=nftlox_dev \
				-p 5432:5432 \
				-v "$SCHEMA_PATH:/docker-entrypoint-initdb.d/001-schema.sql" \
				postgres:16-alpine
			echo "PostgreSQL starting on port 5432"
		fi
		;;
	down)
		docker stop $CONTAINER_NAME 2>/dev/null
		echo "PostgreSQL stopped"
		;;
	reset)
		docker rm -f $CONTAINER_NAME 2>/dev/null
		docker run -d \
			--name $CONTAINER_NAME \
			-e POSTGRES_DB=nftlox_indexer \
			-e POSTGRES_USER=nftlox \
			-e POSTGRES_PASSWORD=nftlox_dev \
			-p 5432:5432 \
			-v "$SCHEMA_PATH:/docker-entrypoint-initdb.d/001-schema.sql" \
			postgres:16-alpine
		echo "PostgreSQL reset (clean DB)"
		;;
	logs)
		docker logs -f $CONTAINER_NAME
		;;
	*)
		echo "Usage: ./db.sh [up|down|reset|logs]"
		;;
esac
