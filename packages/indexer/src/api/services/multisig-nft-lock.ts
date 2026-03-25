/**
 * In-memory NFT lock for multisig signing.
 *
 * Prevents two buyers from obtaining co-signatures for the same NFT
 * simultaneously. The lock auto-expires after the transaction expiration
 * window, ensuring no permanent locks on stale requests.
 *
 * Uses closures — no classes, no `this`.
 */

const CLEANUP_INTERVAL_MS = 60_000;

type LockEntry = {
	readonly buyer: string;
	readonly expiresAt: number;
};

type AcquireResult =
	| { readonly acquired: true }
	| { readonly acquired: false; readonly heldBy: string; readonly retryAfterMs: number };

export function createMultisigNftLock(): {
	readonly acquire: (nftId: string, buyer: string, expirationMs: number) => AcquireResult;
	readonly release: (nftId: string) => void;
	readonly destroy: () => void;
} {
	const locks = new Map<string, LockEntry>();

	const cleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [nftId, entry] of locks) {
			if (now >= entry.expiresAt) {
				locks.delete(nftId);
			}
		}
	}, CLEANUP_INTERVAL_MS);
	cleanupTimer.unref();

	const acquire = (nftId: string, buyer: string, expirationMs: number): AcquireResult => {
		const now = Date.now();
		const existing = locks.get(nftId);

		// Evict expired lock on access
		if (existing && now >= existing.expiresAt) {
			locks.delete(nftId);
		}

		const current = locks.get(nftId);
		if (current) {
			// Same buyer re-requesting is allowed (idempotent retry)
			if (current.buyer === buyer) {
				locks.set(nftId, { buyer, expiresAt: now + expirationMs });
				return { acquired: true };
			}
			return {
				acquired: false,
				heldBy: current.buyer,
				retryAfterMs: current.expiresAt - now,
			};
		}

		locks.set(nftId, { buyer, expiresAt: now + expirationMs });
		return { acquired: true };
	};

	const release = (nftId: string): void => {
		locks.delete(nftId);
	};

	const destroy = (): void => {
		clearInterval(cleanupTimer);
		locks.clear();
	};

	return { acquire, release, destroy } as const;
}
