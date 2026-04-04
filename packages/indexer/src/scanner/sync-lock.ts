/**
 * Dedicated advisory lock manager for the sync engine.
 *
 * PostgreSQL advisory locks are SESSION-level — tied to a specific connection.
 * Using the shared connection pool would risk silent lock release when the pool
 * recycles connections (max_lifetime, idle_timeout). This module maintains a
 * dedicated single-connection instance that holds the lock for the entire sync
 * lifetime, with connection-drop detection and health verification.
 */

import pgClient from "postgres";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("sync-lock");

const SYNC_LOCK_ID = 1;

type LockSql = ReturnType<typeof pgClient>;

// Mutable state — safe in single-threaded JS runtime.
// lockSql is null when no lock connection exists.
let lockSql: LockSql | null = null;
let connectionAlive = false;

function createLockConnection(): LockSql {
	const conn = pgClient(config.databaseUrl, {
		max: 1,
		idle_timeout: 0,
		max_lifetime: 60 * 60 * 24,
		connect_timeout: 30,
		keep_alive: 30,
		onnotice: () => {},
		onclose: () => {
			log.error("Sync lock connection dropped — advisory lock lost");
			connectionAlive = false;
		},
	});
	connectionAlive = true;
	return conn;
}

/**
 * Attempts to acquire the sync advisory lock on a dedicated connection.
 * Returns true if acquired, false if another session holds it.
 * Creates a new dedicated connection if none exists.
 */
export async function acquireSyncLock(): Promise<boolean> {
	try {
		if (!lockSql || !connectionAlive) {
			await destroyLockConnection();
			lockSql = createLockConnection();
		}
		const [row] = await lockSql`SELECT pg_try_advisory_lock(${SYNC_LOCK_ID}) AS acquired`;
		const acquired = row?.acquired === true;
		if (acquired) {
			log.info("Sync advisory lock acquired");
		}
		return acquired;
	} catch (err) {
		log.error("Failed to acquire sync lock", {
			error: err instanceof Error ? err.message : String(err),
		});
		await destroyLockConnection();
		return false;
	}
}

/**
 * Releases the advisory lock and closes the dedicated connection.
 * Safe to call multiple times — idempotent.
 */
export async function releaseSyncLock(): Promise<void> {
	if (!lockSql) return;
	try {
		await lockSql`SELECT pg_advisory_unlock(${SYNC_LOCK_ID})`;
		log.info("Sync advisory lock released");
	} catch {
		// Connection already dead — lock auto-released by PG
	}
	await destroyLockConnection();
}

/**
 * Verifies the lock connection is still alive by pinging PostgreSQL.
 * Returns false if the connection dropped (lock lost).
 */
export async function verifyLockHeld(): Promise<boolean> {
	if (!lockSql || !connectionAlive) return false;
	try {
		const [row] = await lockSql`SELECT 1 AS ok`;
		return row?.ok === 1;
	} catch {
		connectionAlive = false;
		return false;
	}
}

async function destroyLockConnection(): Promise<void> {
	if (lockSql) {
		const conn = lockSql;
		lockSql = null;
		connectionAlive = false;
		await conn.end().catch(() => {});
	}
}
