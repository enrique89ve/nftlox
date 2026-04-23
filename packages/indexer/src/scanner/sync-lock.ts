/**
 * Dedicated advisory lock manager for the sync engine.
 *
 * PostgreSQL advisory locks are SESSION-level — tied to a specific connection.
 * Using the shared connection pool would risk silent lock release when the pool
 * recycles connections (max_lifetime, idle_timeout). This module maintains a
 * dedicated single-connection instance that holds the lock for the entire sync
 * lifetime, with connection-drop detection and health verification.
 *
 * The lifecycle is a discriminated union of three states:
 *   idle      → no dedicated connection
 *   connected → connection alive but session lock not yet held (a prior acquire
 *               was rejected by another holder; kept alive to retry cheaply)
 *   held      → connection alive AND session lock currently acquired; a
 *               heartbeat is scheduled so TCP keep-alives and onclose detect
 *               dead connections even during idle stretches
 *
 * HA note: this module guards AGAINST two indexer processes both acquiring the
 * session lock. It does NOT close the physical window between verifyLockHeld()
 * and a batch commit — the session lock lives on a different connection than
 * the writer's pool connection, so the lock can be lost after a successful
 * verify without the in-flight write failing. Closing that window requires an
 * additional xact-level advisory lock on a distinct key inside the transaction
 * (SYNC_WRITE_FENCE_ID, wired in the sync-engine writer path).
 */

import pgClient from "postgres";
import { config } from "@/config.ts";
import { withTransaction, type Queryable } from "@/db/client.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("sync-lock");

/** Session-level advisory lock — only one indexer process may hold it at a time. */
export const SYNC_HA_LOCK_ID = 1;
/**
 * Transaction-level advisory lock held on the WRITER'S pool connection for the
 * duration of each batch. Released automatically at COMMIT/ROLLBACK. MUST be a
 * different key from SYNC_HA_LOCK_ID: pg_advisory_lock and pg_advisory_xact_lock
 * share a single keyspace, so if they collided, the pool connection (session B)
 * would fail to take the xact lock because the dedicated HA connection
 * (session A) already holds it — the indexer would deadlock against itself.
 */
export const SYNC_WRITE_FENCE_ID = 2;
const LOCK_HEARTBEAT_INTERVAL_MS = 15_000;

type LockSql = ReturnType<typeof pgClient>;
type HeartbeatTimer = ReturnType<typeof setInterval>;

type LockState =
	| { readonly kind: "idle" }
	| { readonly kind: "connected"; readonly sql: LockSql }
	| { readonly kind: "held"; readonly sql: LockSql; readonly heartbeat: HeartbeatTimer };

let state: LockState = { kind: "idle" };

export type AcquireSyncLockResult =
	| { readonly status: "acquired" }
	| { readonly status: "busy" }
	| { readonly status: "unavailable"; readonly error: string };

// ============ Typed error (Symbol-tagged, no class) ============
//
// Thrown by the sync-engine writer path when verifyLockHeld() detects the
// advisory lock was lost. syncLoop identifies it via isSyncLockLostError() and
// re-acquires before the next cycle. A Symbol tag (instead of a class) keeps
// the module free of OOP state while preserving `instanceof Error` checks and
// native stack traces. Symbol.for() ensures cross-realm identity so the guard
// works even if the module is loaded more than once in the process.

const SYNC_LOCK_LOST = Symbol.for("nftlox.sync.lock.lost");

export type SyncLockLostError = Error & { readonly [SYNC_LOCK_LOST]: true };

export function syncLockLostError(message: string, cause?: unknown): SyncLockLostError {
	const err = cause !== undefined
		? new Error(message, { cause })
		: new Error(message);
	Object.defineProperty(err, SYNC_LOCK_LOST, { value: true, enumerable: false, writable: false, configurable: false });
	return err as SyncLockLostError;
}

export function isSyncLockLostError(err: unknown): err is SyncLockLostError {
	return err instanceof Error
		&& (err as { readonly [SYNC_LOCK_LOST]?: unknown })[SYNC_LOCK_LOST] === true;
}

// ============ Connection lifecycle ============

function createLockConnection(): LockSql {
	// `sql` is captured in the `onclose` closure below. Declared as `let` so the
	// callback can reference-compare against the current `state.sql`: stale close
	// callbacks from superseded connections must NOT mutate state owned by a newer
	// connection. Replaces the previous `closingLockConnection` boolean.
	let sql: LockSql;
	sql = pgClient(config.databaseUrl, {
		max: 1,
		idle_timeout: 0,
		max_lifetime: 60 * 60 * 24,
		connect_timeout: 30,
		keep_alive: 30,
		onnotice: () => {},
		onclose: () => {
			if (state.kind === "idle") return;
			if (state.sql !== sql) return;
			if (state.kind === "held") {
				log.error("Sync lock connection dropped — advisory lock lost");
				clearInterval(state.heartbeat);
			} else {
				log.warn("Sync lock connection dropped before advisory lock was acquired");
			}
			state = { kind: "idle" };
		},
	});
	return sql;
}

function startHeartbeat(sql: LockSql): HeartbeatTimer {
	// Per-timer re-entry guard lives in the closure so a slow probe cannot
	// overlap with the next interval tick. Keeping it local (not a module bool)
	// also means concurrent acquire/release calls cannot desync the flag.
	let inFlight = false;
	const timer = setInterval(() => {
		if (inFlight) return;
		inFlight = true;
		sql`SELECT 1`
			.catch(() => {
				// Real connection failures are surfaced via onclose, which transitions
				// state to idle. Swallowing here avoids an unhandled rejection on probe
				// errors that are already observable through the lifecycle callback.
			})
			.finally(() => {
				inFlight = false;
			});
	}, LOCK_HEARTBEAT_INTERVAL_MS);
	timer.unref?.();
	return timer;
}

// ============ Public API ============

/**
 * Attempts to acquire the session advisory lock on a dedicated connection.
 * Returns a discriminated result so callers can distinguish contention (`busy`)
 * from PostgreSQL connectivity loss (`unavailable`). Idempotent when already held.
 */
export async function acquireSyncLock(): Promise<AcquireSyncLockResult> {
	try {
		if (state.kind === "held") return { status: "acquired" };

		const sql = state.kind === "connected" ? state.sql : createLockConnection();
		if (state.kind === "idle") {
			state = { kind: "connected", sql };
		}

		const [row] = await sql`SELECT pg_try_advisory_lock(${SYNC_HA_LOCK_ID}) AS acquired`;
		const acquired = row?.acquired === true;
		if (!acquired) {
			return { status: "busy" };
		}

		// Re-verify the connection is still ours before transitioning to "held".
		// If `onclose` fired during the await above, state reverted to "idle" and
		// `state.sql` no longer matches — don't stamp "held" on a dead connection.
		if (state.kind !== "connected" || state.sql !== sql) {
			return { status: "unavailable", error: "Connection closed during lock acquisition" };
		}

		const heartbeat = startHeartbeat(sql);
		state = { kind: "held", sql, heartbeat };
		log.info("Sync advisory lock acquired");
		return { status: "acquired" };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.error("Failed to acquire sync lock", { error });
		await releaseSyncLock();
		return { status: "unavailable", error };
	}
}

/**
 * Releases the advisory lock and closes the dedicated connection. Idempotent.
 */
export async function releaseSyncLock(): Promise<void> {
	const previous = state;
	if (previous.kind === "idle") return;

	// Transition synchronously so concurrent callers don't act on stale state
	// while the async close is in flight. The closed connection's `onclose`
	// callback will see `state.sql !== previous.sql` and stay a no-op.
	state = { kind: "idle" };

	if (previous.kind === "held") {
		clearInterval(previous.heartbeat);
		try {
			await previous.sql`SELECT pg_advisory_unlock(${SYNC_HA_LOCK_ID})`;
			log.info("Sync advisory lock released");
		} catch {
			// Connection already dead — PG auto-released the session lock.
		}
	}

	try {
		await previous.sql.end({ timeout: 5 });
	} catch {
		// Already closed / refused to end cleanly. Safe to ignore.
	}
}

/**
 * Verifies the lock connection is still alive AND holding the advisory lock.
 * Returns false if the connection dropped (lock lost) or we never had it.
 *
 * Point-in-time only: a `true` return does not survive subsequent awaits because
 * the writer runs on a different pool connection. Combine with the xact-level
 * fence (SYNC_WRITE_FENCE_ID) inside the transaction to close the race window.
 */
export async function verifyLockHeld(): Promise<boolean> {
	if (state.kind !== "held") return false;
	try {
		const [row] = await state.sql`SELECT 1 AS ok`;
		return row?.ok === 1;
	} catch {
		// Real connection failures fire onclose, which transitions state to idle.
		return false;
	}
}

// ============ Writer-path transaction with xact-level fence ============

/**
 * Writer-path transaction wrapper for the sync engine. Opens a transaction on
 * the shared pool and, as the first statement on that connection, takes an
 * advisory lock on SYNC_WRITE_FENCE_ID for the duration of the transaction.
 *
 * Closes the physical race window that the session-level HA lock leaves open:
 * the HA lock lives on a dedicated connection, but writes run on a pool
 * connection. If the HA connection drops between verifyLockHeld() and commit,
 * PG auto-releases the HA lock, another indexer can acquire it, and both
 * writers can then proceed on their respective (still-alive) pool connections.
 * The xact fence prevents that overlap because it is held on the same
 * connection as the writes: only one pool connection across all indexers can
 * hold SYNC_WRITE_FENCE_ID at any instant. If this connection dies, the lock
 * is released together with the transaction — there is no divergence window.
 *
 * On contention (another writer holds the fence) the helper throws
 * syncLockLostError so syncLoop can re-acquire the HA lock and retry rather
 * than applying the normal error backoff. postgres.js rolls back the (empty)
 * transaction on throw, which releases any lock state this path took.
 */
export async function withSyncWriteTransaction<T>(
	fn: (txn: Queryable) => Promise<T>,
): Promise<T> {
	return withTransaction(async (txn) => {
		const [row] = await txn`SELECT pg_try_advisory_xact_lock(${SYNC_WRITE_FENCE_ID}) AS acquired`;
		if (row?.acquired !== true) {
			throw syncLockLostError(
				"Sync write fence unavailable — another indexer holds the batch lock",
			);
		}
		return fn(txn);
	});
}
