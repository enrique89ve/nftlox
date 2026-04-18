import type { Queryable } from "@/db/client.ts";

/**
 * Helpers that couple indexer handlers to the API-side `multisig_locks` table.
 *
 * A lock row is planted by `/api/multisig` when the node co-signs a `buy`. Until
 * the row's `expires_at` passes the indexer's clock (`op.timestamp`), five
 * actions on the same NFT (`transfer`, `transfer_from`, `unlist`, `burn`,
 * `lend`) are rejected so a buyer cannot have the seat pulled from under them
 * mid-flight. The matching `buy` — same `(buyer, listing_id, list_tx_id)` —
 * consumes the lock atomically; a non-matching `buy` (e.g. a different node
 * already co-signed a different buyer) is accepted WITHOUT consuming the lock
 * so the other node's signed tx remains protected until it too lands or times
 * out.
 *
 * ── Dual-clock convention (intentional) ────────────────────────────────────
 * THIS file uses `op.timestamp` (block time), NEVER `NOW()`. Every indexer
 * processing the same block must reach the same accept/reject decision, and
 * wall-clock drift between nodes would fork their state-roots. An active lock
 * is one where `expires_at > op.timestamp`.
 *
 * The paired API-side file (`api/services/multisig-nft-lock.ts`) intentionally
 * uses `NOW()` — it only serializes concurrent signing requests within ONE
 * node, where wall-clock is the correct clock. See that file for the full
 * rationale. Do not unify the two clocks.
 */

export type ActiveMultisigLock = Readonly<{
	readonly nft_id: string;
	readonly buyer: string;
	readonly listing_id: string;
	readonly list_tx_id: string;
	readonly snapshot_block: number;
	readonly expires_at: string;
}>;

function rowToLock(row: Record<string, unknown>): ActiveMultisigLock {
	return {
		nft_id: String(row.nft_id),
		buyer: String(row.buyer),
		listing_id: String(row.listing_id),
		list_tx_id: String(row.list_tx_id),
		snapshot_block: Number(row.snapshot_block),
		expires_at: String(row.expires_at),
	};
}

export async function getActiveMultisigLock(
	nftId: string,
	blockTimestamp: string,
	txn: Queryable,
): Promise<ActiveMultisigLock | null> {
	const [row] = await txn`
		SELECT nft_id, buyer, listing_id, list_tx_id, snapshot_block, expires_at
		  FROM multisig_locks
		 WHERE nft_id = ${nftId}
		   AND expires_at > ${blockTimestamp}::timestamptz
	`;
	return row ? rowToLock(row) : null;
}

/**
 * Throws if a non-expired lock exists for the NFT. Callers should invoke this
 * as the FIRST check inside a handler that competes with an in-flight buy.
 */
export async function assertNoActiveMultisigLock(
	nftId: string,
	blockTimestamp: string,
	txn: Queryable,
): Promise<void> {
	const lock = await getActiveMultisigLock(nftId, blockTimestamp, txn);
	if (lock) {
		throw new Error(
			`multisig_lock_active: NFT ${nftId} has a pending buy by '${lock.buyer}' ` +
				`(listing ${lock.listing_id}, expires ${lock.expires_at}) — retry after expiration`,
		);
	}
}

export type ConsumeMultisigLockInput = Readonly<{
	nftId: string;
	buyer: string;
	listingId: string;
	listTxId: string;
	blockTimestamp: string;
	txn: Queryable;
}>;

export type ConsumeMultisigLockResult =
	| Readonly<{ readonly outcome: "consumed" }>
	| Readonly<{ readonly outcome: "no_lock" }>
	| Readonly<{ readonly outcome: "foreign_lock"; readonly lock: ActiveMultisigLock }>;

/**
 * Atomically deletes the lock row for this NFT iff it matches the buy's
 * identity triple. Outcomes:
 *
 *   • `consumed`       — a matching lock existed and is now gone; the buy is
 *                        the one this node co-signed, continue as normal.
 *   • `no_lock`        — no active lock row. The buy was co-signed by another
 *                        node (whose lock lives in its own DB) or the lock
 *                        already expired; continue as normal.
 *   • `foreign_lock`   — an active lock exists but belongs to a different
 *                        `(buyer, listing_id, list_tx_id)`. The caller should
 *                        accept the buy (another node's signed tx landed
 *                        faster) but leave the foreign lock alone so IT can
 *                        still protect its in-flight tx until expiration.
 */
export async function consumeMultisigLockIfMatches(
	input: ConsumeMultisigLockInput,
): Promise<ConsumeMultisigLockResult> {
	const { nftId, buyer, listingId, listTxId, blockTimestamp, txn } = input;

	const [deleted] = await txn`
		DELETE FROM multisig_locks
		 WHERE nft_id = ${nftId}
		   AND buyer = ${buyer}
		   AND listing_id = ${listingId}
		   AND list_tx_id = ${listTxId}
		   AND expires_at > ${blockTimestamp}::timestamptz
		RETURNING nft_id
	`;
	if (deleted) {
		return { outcome: "consumed" };
	}

	const foreign = await getActiveMultisigLock(nftId, blockTimestamp, txn);
	if (foreign) {
		return { outcome: "foreign_lock", lock: foreign };
	}
	return { outcome: "no_lock" };
}
