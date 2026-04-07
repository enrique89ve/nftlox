import pgClient from "postgres";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("db");

export const sql = pgClient(config.databaseUrl, {
	max: 10,
	idle_timeout: 30,
	max_lifetime: 60 * 30,
	connect_timeout: 30,
	keep_alive: 60,
	backoff: (retries: number) => Math.min(Math.pow(2, retries) * 0.5, 20),
	onnotice: () => {},
	onclose: (connId: number) => {
		log.warn("DB connection closed", { connectionId: connId });
	},
});

/**
 * Queryable = Sql<{}> (the pool type). Both Sql and TransactionSql support
 * tagged-template queries, but TS's Omit<> strips call signatures from
 * TransactionSql making a union non-callable. We use Sql as the canonical
 * type and contain the single cast in `withTransaction()` below.
 */
export type Queryable = typeof sql;

/**
 * Wraps sql.begin() with Queryable-typed callback.
 *
 * postgres.TransactionSql and Sql<{}> share the same tagged-template callable interface —
 * all query functions in this codebase use only that interface, never pool-only methods.
 * The single cast (TransactionSql → Queryable) is structurally sound and contained here
 * so callers and query functions never see the postgres internals.
 */
export async function withTransaction<T>(fn: (txn: Queryable) => Promise<T>): Promise<T> {
	// TransactionSql and Sql<{}> share the same tagged-template callable interface.
	// The cast (TransactionSql → Queryable) is structurally sound — all query functions
	// in this codebase use only that interface, never pool-only methods (begin/end).
	// The outer `as T` is needed because sql.begin() returns UnwrapPromiseArray<T>
	// which TypeScript cannot resolve to T in generic contexts.
	const result = await sql.begin(txSql => fn(txSql as unknown as Queryable));
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
