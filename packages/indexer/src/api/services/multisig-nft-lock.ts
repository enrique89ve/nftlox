import { sql } from "@/db/client.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("multisig:lock");

/**
 * API-side per-NFT lock factory for the multisig buy flow.
 *
 * Pairs with `utils/multisig-locks.ts` (the indexer-side gate). Together they
 * form a two-layer mutex: the API plants a row when it co-signs a buy; every
 * ownership-mutating handler refuses to run while a non-expired row exists.
 *
 * ── Dual-clock convention (intentional) ────────────────────────────────────
 * THIS file uses `NOW()` (wall-clock). It runs in the API request path, where
 * the only meaningful clock is the server's. Expirations are written as
 * `Date.now() + expirationMs` and cleaned up by `expires_at < NOW()`.
 *
 * `utils/multisig-locks.ts` instead reads `expires_at > op.timestamp` — the
 * block clock. That side runs inside indexer handlers, where every node
 * processing the same block MUST reach the same accept/reject decision; using
 * wall-clock there would let nodes drift and diverge their state-roots.
 *
 * The asymmetry is deliberate: API serializes concurrent signing requests
 * within ONE node (wall-clock is fine), while the indexer enforces a globally
 * deterministic gate (block-clock is required). Don't unify them.
 */
export type NftLockAcquireInput = Readonly<{
	nftId: string;
	buyer: string;
	listingId: string;
	listTxId: string;
	snapshotBlock: number;
	expirationMs: number;
}>;

export type NftLockAcquireResult =
	| { readonly acquired: true }
	| { readonly acquired: false; readonly heldBy: string; readonly retryAfterMs: number };

export type MultisigNftLock = Readonly<{
	readonly acquire: (input: NftLockAcquireInput) => Promise<NftLockAcquireResult>;
	readonly release: (nftId: string, buyer: string) => Promise<void>;
	readonly cleanupExpired: () => Promise<void>;
	readonly destroy: () => void;
}>;

// Upper bound for spin-retries when a concurrent expiration leaves the table
// momentarily empty between DELETE and INSERT. Two attempts is ample because
// only one tx wins the INSERT; a third is effectively a different caller.
const MAX_ACQUIRE_RETRIES = 2;

// Cadence for background sweep of expired rows. Expirations are also enforced
// inline in acquire/handlers; this sweep keeps the table size bounded when a
// lock expires without ever being consumed or re-requested.
const CLEANUP_INTERVAL_MS = 60_000;

export function createMultisigNftLock(): MultisigNftLock {
	const cleanupTimer = setInterval(() => {
		// Background sweep is best-effort: the inline cleanup CTE in `acquire`
		// guarantees correctness, so a transient pool/network blip here is not
		// fatal. We log instead of swallowing so a sustained DB outage shows
		// up in operator dashboards rather than dying silently.
		cleanupExpired().catch((err: unknown) => {
			log.warn("background cleanup of expired locks failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}, CLEANUP_INTERVAL_MS);
	cleanupTimer.unref();

	const acquire = async (input: NftLockAcquireInput, attempt = 0): Promise<NftLockAcquireResult> => {
		const { nftId, buyer, listingId, listTxId, snapshotBlock, expirationMs } = input;
		const expiresAt = new Date(Date.now() + expirationMs).toISOString();

		// Atomic cleanup-and-insert. ON CONFLICT path makes the call idempotent for
		// the same (buyer, listing_id) — a retry by the same buyer on the same
		// listing extends expires_at. A different buyer, or the same buyer after
		// the seller relisted with a fresh listing_id, cannot reuse the slot.
		const [inserted] = await sql`
			WITH cleanup AS (
				DELETE FROM multisig_locks WHERE nft_id = ${nftId} AND expires_at < NOW()
			)
			INSERT INTO multisig_locks (nft_id, action, buyer, listing_id, list_tx_id, snapshot_block, expires_at)
			VALUES (${nftId}, 'buy', ${buyer}, ${listingId}, ${listTxId}, ${snapshotBlock}, ${expiresAt})
			ON CONFLICT (nft_id) DO UPDATE
				SET list_tx_id = EXCLUDED.list_tx_id,
				    snapshot_block = EXCLUDED.snapshot_block,
				    expires_at = EXCLUDED.expires_at
				WHERE multisig_locks.buyer = EXCLUDED.buyer
				  AND multisig_locks.listing_id = EXCLUDED.listing_id
			RETURNING nft_id
		`;

		if (inserted) {
			return { acquired: true };
		}

		const [existing] = await sql`
			SELECT buyer, expires_at FROM multisig_locks WHERE nft_id = ${nftId}
		`;
		if (!existing && attempt < MAX_ACQUIRE_RETRIES) {
			return acquire(input, attempt + 1);
		}
		if (!existing) {
			return { acquired: false, heldBy: "unknown", retryAfterMs: 1000 };
		}

		const retryAfterMs = Math.max(0, new Date(String(existing.expires_at)).getTime() - Date.now());
		return { acquired: false, heldBy: String(existing.buyer), retryAfterMs };
	};

	// Buyer-scoped: only the buyer that acquired the lock can release it, so
	// a late-arriving release from a previous buyer can never nuke an active
	// lock held by someone else.
	const release = async (nftId: string, buyer: string): Promise<void> => {
		await sql`DELETE FROM multisig_locks WHERE nft_id = ${nftId} AND buyer = ${buyer}`;
	};

	const cleanupExpired = async (): Promise<void> => {
		await sql`DELETE FROM multisig_locks WHERE expires_at < NOW()`;
	};

	const destroy = (): void => {
		clearInterval(cleanupTimer);
	};

	return { acquire, release, cleanupExpired, destroy } as const;
}
