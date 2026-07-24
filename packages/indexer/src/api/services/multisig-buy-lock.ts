import { sql } from "@/db/client.ts";
import type { BuyLockAcquisition } from "@/api/services/multisig/types.ts";

export type MultisigBuyLock = Readonly<{
	readonly acquire: (
		nftId: string,
		listingId: string,
		listTxId: string,
		holder: string,
		expirationMs: number,
	) => Promise<BuyLockAcquisition>;
	readonly release: (nftId: string, holder: string) => Promise<void>;
	readonly cleanupExpired: () => Promise<void>;
	readonly destroy: () => void;
}>;

export function createMultisigBuyLock(): MultisigBuyLock {
	const cleanupTimer = setInterval(() => {
		cleanupExpired().catch(() => {});
	}, 60_000);
	cleanupTimer.unref();

	const MAX_ACQUIRE_RETRIES = 2;

	const acquire = async (
		nftId: string,
		listingId: string,
		listTxId: string,
		holder: string,
		expirationMs: number,
		attempt = 0,
	): Promise<BuyLockAcquisition> => {
		const expiresAt = new Date(Date.now() + expirationMs).toISOString();

		const [inserted] = await sql`
			WITH cleanup AS (
				DELETE FROM multisig_buy_locks
				WHERE nft_id = ${nftId} AND expires_at < NOW()
			)
			INSERT INTO multisig_buy_locks (nft_id, listing_id, listing_tx_id, holder, expires_at)
			VALUES (${nftId}, ${listingId}, ${listTxId}, ${holder}, ${expiresAt})
			ON CONFLICT (nft_id) DO NOTHING
			RETURNING nft_id
		`;

		if (inserted) {
			return { acquired: true };
		}

		const [existing] = await sql`
			SELECT holder, expires_at
			FROM multisig_buy_locks
			WHERE nft_id = ${nftId}
		`;
		if (!existing && attempt < MAX_ACQUIRE_RETRIES) {
			return acquire(nftId, listingId, listTxId, holder, expirationMs, attempt + 1);
		}
		if (!existing) {
			return { acquired: false, heldBy: "unknown", retryAfterMs: 1000 };
		}

		const retryAfterMs = Math.max(0, new Date(String(existing.expires_at)).getTime() - Date.now());
		return { acquired: false, heldBy: String(existing.holder), retryAfterMs };
	};

	const release = async (nftId: string, holder: string): Promise<void> => {
		await sql`
			DELETE FROM multisig_buy_locks
			WHERE nft_id = ${nftId} AND holder = ${holder}
		`;
	};

	const cleanupExpired = async (): Promise<void> => {
		await sql`DELETE FROM multisig_buy_locks WHERE expires_at < NOW()`;
	};

	const destroy = (): void => {
		clearInterval(cleanupTimer);
	};

	return { acquire, release, cleanupExpired, destroy } as const;
}
