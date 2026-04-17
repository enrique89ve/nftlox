import pgClient from "postgres";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";
import { createStateRootBuffer, type StateRootBuffer } from "@/utils/state-root-buffer.ts";
import { flushStateRootBuffer } from "@/db/queries/state-root.ts";

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

// WeakMap keyed on the tx handle; entry GC'd automatically when the tx
// completes and the txSql reference is released.
const txBuffers = new WeakMap<object, StateRootBuffer>();

/**
 * Returns the StateRootBuffer attached to the given transaction handle.
 * Throws if called outside withTransaction — all SPV-affecting mutations
 * MUST run inside a transaction so a crash mid-batch rolls back cleanly.
 */
export function getStateRootBuffer(txn: Queryable): StateRootBuffer {
	const buf = txBuffers.get(txn as unknown as object);
	if (!buf) {
		throw new Error(
			"getStateRootBuffer: no buffer attached. Call within withTransaction().",
		);
	}
	return buf;
}

/**
 * Wraps sql.begin() with Queryable-typed callback and a state-root buffer.
 *
 * postgres.TransactionSql and Sql<{}> share the same tagged-template callable interface.
 * The cast (TransactionSql → Queryable) is structurally sound — all query functions
 * in this codebase use only that interface, never pool-only methods.
 *
 * Buffer lifecycle: created on entry, attached via WeakMap keyed on the tx handle,
 * flushed in a single SELECT+UPDATE before the tx commits. If flush throws, the
 * whole tx rolls back together with the user fn's writes — no divergence possible.
 */
export async function withTransaction<T>(fn: (txn: Queryable) => Promise<T>): Promise<T> {
	const result = await sql.begin(async (txSql) => {
		const txn = txSql as unknown as Queryable;
		const buffer = createStateRootBuffer();
		txBuffers.set(txSql as unknown as object, buffer);
		try {
			const r = await fn(txn);
			await flushStateRootBuffer(buffer, txn);
			return r;
		} finally {
			txBuffers.delete(txSql as unknown as object);
		}
	});
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
