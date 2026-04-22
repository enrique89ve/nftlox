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
const LOCK_HEARTBEAT_INTERVAL_MS = 15_000;

type LockSql = ReturnType<typeof pgClient>;
type HeartbeatTimer = ReturnType<typeof setInterval>;

export type AcquireSyncLockResult =
	| { readonly status: "acquired" }
	| { readonly status: "busy" }
	| { readonly status: "unavailable"; readonly error: string };

// Mutable state — safe in single-threaded JS runtime.
// lockSql is null when no lock connection exists.
let lockSql: LockSql | null = null;
let connectionAlive = false;
let lockHeld = false;
let heartbeatTimer: HeartbeatTimer | null = null;
let heartbeatInFlight = false;
let closingLockConnection = false;

function createLockConnection(): LockSql {
	const conn = pgClient(config.databaseUrl, {
		max: 1,
		idle_timeout: 0,
		max_lifetime: 60 * 60 * 24,
		connect_timeout: 30,
		keep_alive: 30,
		onnotice: () => {},
		onclose: () => {
			if (closingLockConnection) {
				connectionAlive = false;
				lockHeld = false;
				stopLockHeartbeat();
				return;
			}
			if (lockHeld) {
				log.error("Sync lock connection dropped — advisory lock lost");
			} else {
				log.warn("Sync lock connection dropped before advisory lock was acquired");
			}
			connectionAlive = false;
			lockHeld = false;
			stopLockHeartbeat();
		},
	});
	connectionAlive = true;
	return conn;
}

function startLockHeartbeat(): void {
	if (heartbeatTimer) return;
	heartbeatTimer = setInterval(() => {
		void heartbeatLockConnection();
	}, LOCK_HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref?.();
}

function stopLockHeartbeat(): void {
	if (!heartbeatTimer) return;
	clearInterval(heartbeatTimer);
	heartbeatTimer = null;
}

async function heartbeatLockConnection(): Promise<void> {
	if (!lockSql || !connectionAlive || !lockHeld || heartbeatInFlight) return;
	heartbeatInFlight = true;
	try {
		await lockSql`SELECT 1`;
	} catch {
		connectionAlive = false;
		lockHeld = false;
	} finally {
		heartbeatInFlight = false;
	}
}

/**
 * Attempts to acquire the sync advisory lock on a dedicated connection.
 * Returns a structured status so callers can distinguish lock contention
 * from PostgreSQL connectivity loss.
 * Creates a new dedicated connection if none exists.
 */
export async function acquireSyncLock(): Promise<AcquireSyncLockResult> {
	try {
		if (lockSql && connectionAlive && lockHeld) {
			return { status: "acquired" };
		}
		if (!lockSql || !connectionAlive) {
			await destroyLockConnection();
			lockSql = createLockConnection();
		}
		const [row] = await lockSql`SELECT pg_try_advisory_lock(${SYNC_LOCK_ID}) AS acquired`;
		const acquired = row?.acquired === true;
		if (acquired) {
			lockHeld = true;
			startLockHeartbeat();
			log.info("Sync advisory lock acquired");
			return { status: "acquired" };
		}
		lockHeld = false;
		stopLockHeartbeat();
		return { status: "busy" };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.error("Failed to acquire sync lock", {
			error,
		});
		await destroyLockConnection();
		return { status: "unavailable", error };
	}
}

/**
 * Releases the advisory lock and closes the dedicated connection.
 * Safe to call multiple times — idempotent.
 */
export async function releaseSyncLock(): Promise<void> {
	if (!lockSql) return;
	try {
		if (lockHeld) {
			await lockSql`SELECT pg_advisory_unlock(${SYNC_LOCK_ID})`;
			log.info("Sync advisory lock released");
		}
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
	if (!lockSql || !connectionAlive || !lockHeld) return false;
	try {
		const [row] = await lockSql`SELECT 1 AS ok`;
		const held = row?.ok === 1;
		if (!held) {
			lockHeld = false;
		}
		return held;
	} catch {
		connectionAlive = false;
		lockHeld = false;
		return false;
	}
}

async function destroyLockConnection(): Promise<void> {
	stopLockHeartbeat();
	heartbeatInFlight = false;
	if (lockSql) {
		const conn = lockSql;
		lockSql = null;
		connectionAlive = false;
		lockHeld = false;
		closingLockConnection = true;
		try {
			await conn.end().catch(() => {});
		} finally {
			closingLockConnection = false;
		}
	}
}
