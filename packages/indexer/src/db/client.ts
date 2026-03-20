import type postgres from "postgres";
import pgClient from "postgres";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("db");

export const sql = pgClient(config.databaseUrl, {
	max: 10,
	idle_timeout: 20,
	connect_timeout: 10,
	onnotice: () => {},
});

/**
 * Queryable = Sql<{}> (the pool type). Both Sql and TransactionSql support
 * tagged-template queries, but TS's Omit<> strips call signatures from
 * TransactionSql making a union non-callable. We use Sql as the canonical
 * type and contain the single cast in `withTransaction()` below.
 */
export type Queryable = typeof sql;

/**
 * Wraps sql.begin() with Queryable-typed callback. The cast is safe because
 * TransactionSql inherits all tagged-template callable behavior from Sql.
 */
export async function withTransaction<T>(fn: (txn: Queryable) => Promise<T>): Promise<T> {
	const result = await sql.begin(fn as unknown as (sql: postgres.TransactionSql) => Promise<T>);
	return result as T;
}

const MAX_QUERY_LIMIT = 1000;

/**
 * Clamps a pagination limit to a safe maximum.
 * Even if Elysia schema validation is bypassed, this prevents unbounded SELECTs.
 */
export function clampLimit(limit: number, defaultVal = 50): number {
	if (limit < 1 || !Number.isFinite(limit)) return defaultVal;
	return Math.min(limit, MAX_QUERY_LIMIT);
}

export async function testConnection(): Promise<void> {
	const [row] = await sql`SELECT 1 as ok`;
	if (row?.ok !== 1) throw new Error("Database connection test failed");
	log.info("Database connected");
}

export async function closePool(): Promise<void> {
	await sql.end();
	log.info("Database pool closed");
}
