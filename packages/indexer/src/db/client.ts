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

// Minimal interface for TransactionSql.savepoint<T>() — the callback-based
// savepoint API from postgres.js. The callback receives a nested transaction
// scoped to the savepoint, and postgres.js handles ROLLBACK TO SAVEPOINT
// automatically if the callback throws.
type TxWithSavepoint = {
	savepoint<T>(fn: (sp: TxWithSavepoint) => Promise<T>): Promise<T>;
};

// WeakMap keyed on the tx handle; entry GC'd automatically when the tx
// completes and the txSql reference is released.
const txBuffers = new WeakMap<object, StateRootBuffer>();

// WeakMap storing the original TransactionSql handle (which has .savepoint()).
// Needed because withTransaction() casts TransactionSql to Queryable, losing
// the savepoint method. handlers in action-router.ts retrieve this to wrap
// their mutations in a savepoint.
const txSavepointHandles = new WeakMap<object, TxWithSavepoint>();

/**
 * Queryable widened with the handler-facing context attached by
 * `attachScope`. Attachment is structural — no string-keyed `as any`
 * lookups are needed by readers or writers.
 */
export type ScopedQueryable = Queryable & {
	readonly __nftlox_buffer?: StateRootBuffer | undefined;
	readonly __nftlox_handle?: TxWithSavepoint | undefined;
};

/**
 * Attaches the state-root buffer and savepoint handle onto the queryable
 * tag so downstream `getStateRootBuffer`/`getTxSavepointHandle` can read
 * them without a WeakMap hit. Used by action-router when creating a
 * per-handler savepoint.
 */
export function attachScope(
	sql: Queryable,
	ctx: { buffer: StateRootBuffer; handle: TxWithSavepoint },
): ScopedQueryable {
	const tagged: ScopedQueryable = Object.assign(sql, {
		__nftlox_buffer: ctx.buffer,
		__nftlox_handle: ctx.handle,
	});
	return tagged;
}

/**
 * Returns the StateRootBuffer attached to the given transaction handle.
 * Throws if called outside withTransaction — all SPV-affecting mutations
 * MUST run inside a transaction so a crash mid-batch rolls back cleanly.
 *
 * For savepoint-scoped transactions, reads the structural `__nftlox_buffer`
 * field first (attached by action-router when creating a savepoint), then
 * falls back to the WeakMap entry attached by `withTransaction`.
 */
export function getStateRootBuffer(txn: Queryable): StateRootBuffer {
	const scoped = txn as ScopedQueryable;
	if (scoped.__nftlox_buffer) return scoped.__nftlox_buffer;
	const buf = txBuffers.get(txn as unknown as object);
	if (!buf) {
		throw new Error(
			"getStateRootBuffer: no buffer attached. Call within withTransaction().",
		);
	}
	return buf;
}

/**
 * Returns the savepoint-capable handle for the given transaction.
 * Throws if called outside withTransaction. Handlers in action-router.ts
 * use this to wrap their mutations in a savepoint, enabling per-handler
 * rollback on failure without aborting the entire batch transaction.
 *
 * For savepoint-scoped transactions, reads `__nftlox_handle` first
 * (attached by action-router when creating a savepoint), then falls back
 * to the WeakMap entry from `withTransaction`.
 */
export function getTxSavepointHandle(txn: Queryable): TxWithSavepoint {
	const scoped = txn as ScopedQueryable;
	if (scoped.__nftlox_handle) return scoped.__nftlox_handle;
	const handle = txSavepointHandles.get(txn as unknown as object);
	if (!handle) {
		throw new Error(
			"getTxSavepointHandle: not in a transaction. Call within withTransaction().",
		);
	}
	return handle;
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
 *
 * Savepoint handle lifecycle: the original TransactionSql (which has .savepoint())
 * is stored in txSavepointHandles so handlers can access the savepoint API despite
 * the type being cast to Queryable. The entry is cleaned up after the tx completes.
 */
export async function withTransaction<T>(fn: (txn: Queryable) => Promise<T>): Promise<T> {
	const result = await sql.begin(async (txSql) => {
		const txn = txSql as unknown as Queryable;
		const buffer = createStateRootBuffer();
		const txKey = txSql as unknown as object;
		txBuffers.set(txKey, buffer);
		txSavepointHandles.set(txKey, txSql as unknown as TxWithSavepoint);
		try {
			const r = await fn(txn);
			await flushStateRootBuffer(buffer, txn);
			return r;
		} finally {
			txBuffers.delete(txKey);
			txSavepointHandles.delete(txKey);
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
