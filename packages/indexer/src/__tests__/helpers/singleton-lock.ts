import { afterAll, beforeAll } from "bun:test";
import pgClient from "postgres";
import { config } from "@/config.ts";

/**
 * Test-only advisory lock that serializes suites which mutate singleton rows
 * in `state_meta` / `sync_state` (id = 1). Five suites currently touch those
 * rows — running any two of them concurrently against the same database would
 * race the fixtures and produce non-deterministic failures.
 *
 * Bun's default in-process sequential execution masked the race today, but
 * relying on that is an undocumented invariant that any future config tweak
 * (`bun test --concurrency`, parallel CI shards on one DB, an IDE-driven
 * runner that spawns workers) could silently break. Acquiring a Postgres
 * advisory lock makes the invariant explicit and enforceable across any
 * number of concurrent test processes pointing at the same database.
 *
 * Why a dedicated connection (not the shared pool):
 *   Session-level advisory locks live on the connection that took them.
 *   `db/client.ts` uses a pool of 10 with idle recycling — calling
 *   `pg_advisory_lock` on the pool and then `pg_advisory_unlock` later may
 *   land on a different physical connection, leaving the lock orphaned until
 *   the original connection is recycled. The production sync engine solves
 *   the same problem in `scanner/sync-lock.ts` by maintaining its own
 *   single-connection client; we mirror that approach here.
 *
 * Key space:
 *   Production code reserves SYNC_HA_LOCK_ID (1) and SYNC_WRITE_FENCE_ID (2)
 *   in `scanner/sync-lock.ts`. Pick a value far above those so a future
 *   production lock cannot accidentally collide with the test lock.
 */
const TEST_SINGLETON_LOCK_ID = 0xC0_FFEE;

/**
 * Hook-level timeout for acquire + release. Bun's default per-hook timeout
 * is 5 s, which is too short when several suites contend for the lock at
 * once (longer suites can hold it for tens of seconds during a full run).
 * 120 s comfortably exceeds the slowest singleton-mutating suite end-to-end
 * while still aborting if the lock is permanently held by a leaked process.
 */
const LOCK_HOOK_TIMEOUT_MS = 120_000;

export function useSingletonLock(): void {
	let conn: ReturnType<typeof pgClient> | null = null;

	beforeAll(async () => {
		conn = pgClient(config.databaseUrl, {
			max: 1,
			idle_timeout: 0,
			max_lifetime: 0,
			onnotice: () => {},
		});
		await conn`SELECT pg_advisory_lock(${TEST_SINGLETON_LOCK_ID})`;
	}, LOCK_HOOK_TIMEOUT_MS);

	afterAll(async () => {
		if (conn === null) return;
		try {
			await conn`SELECT pg_advisory_unlock(${TEST_SINGLETON_LOCK_ID})`;
		} finally {
			await conn.end({ timeout: 5 });
			conn = null;
		}
	}, LOCK_HOOK_TIMEOUT_MS);
}
