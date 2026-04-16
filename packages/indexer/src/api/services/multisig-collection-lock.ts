import { sql } from "@/db/client.ts";

export type CollectionLockAcquireResult =
	| { readonly acquired: true }
	| { readonly acquired: false; readonly heldBy: string; readonly retryAfterMs: number };

export type MultisigCollectionLock = Readonly<{
	readonly acquire: (
		creator: string,
		symbol: string,
		holder: string,
		expirationMs: number,
	) => Promise<CollectionLockAcquireResult>;
	readonly release: (creator: string, symbol: string, holder: string) => Promise<void>;
	readonly cleanupExpired: () => Promise<void>;
	readonly destroy: () => void;
}>;

export function createMultisigCollectionLock(): MultisigCollectionLock {
	const cleanupTimer = setInterval(() => {
		cleanupExpired().catch(() => {});
	}, 60_000);
	cleanupTimer.unref();

	const MAX_ACQUIRE_RETRIES = 2;

	const acquire = async (
		creator: string,
		symbol: string,
		holder: string,
		expirationMs: number,
		attempt = 0,
	): Promise<CollectionLockAcquireResult> => {
		const expiresAt = new Date(Date.now() + expirationMs).toISOString();

		// Atomic: delete expired + insert/update in a single statement to avoid TOCTOU.
		// Same holder can refresh its own lock; a different holder only wins if the
		// existing row has already expired (deleted by the CTE).
		const [inserted] = await sql`
			WITH cleanup AS (
				DELETE FROM multisig_collection_locks
				WHERE creator = ${creator} AND symbol = ${symbol} AND expires_at < NOW()
			)
			INSERT INTO multisig_collection_locks (creator, symbol, holder, expires_at)
			VALUES (${creator}, ${symbol}, ${holder}, ${expiresAt})
			ON CONFLICT (creator, symbol) DO UPDATE
				SET holder = ${holder}, expires_at = ${expiresAt}
				WHERE multisig_collection_locks.holder = ${holder}
			RETURNING creator
		`;

		if (inserted) {
			return { acquired: true };
		}

		const [existing] = await sql`
			SELECT holder, expires_at
			FROM multisig_collection_locks
			WHERE creator = ${creator} AND symbol = ${symbol}
		`;
		if (!existing && attempt < MAX_ACQUIRE_RETRIES) {
			return acquire(creator, symbol, holder, expirationMs, attempt + 1);
		}
		if (!existing) {
			return { acquired: false, heldBy: "unknown", retryAfterMs: 1000 };
		}

		const retryAfterMs = Math.max(0, new Date(String(existing.expires_at)).getTime() - Date.now());
		return { acquired: false, heldBy: String(existing.holder), retryAfterMs };
	};

	// Holder-scoped: only the holder that acquired the lock can release it, so a
	// late-arriving release from a stale request can never nuke an active lock.
	const release = async (creator: string, symbol: string, holder: string): Promise<void> => {
		await sql`
			DELETE FROM multisig_collection_locks
			WHERE creator = ${creator} AND symbol = ${symbol} AND holder = ${holder}
		`;
	};

	const cleanupExpired = async (): Promise<void> => {
		await sql`DELETE FROM multisig_collection_locks WHERE expires_at < NOW()`;
	};

	const destroy = (): void => {
		clearInterval(cleanupTimer);
	};

	return { acquire, release, cleanupExpired, destroy } as const;
}
