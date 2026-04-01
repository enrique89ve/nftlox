import { sql } from "@/db/client.ts";

type AcquireResult =
	| { readonly acquired: true }
	| { readonly acquired: false; readonly heldBy: string; readonly retryAfterMs: number };

export function createMultisigNftLock(): {
	readonly acquire: (nftId: string, buyer: string, expirationMs: number) => Promise<AcquireResult>;
	readonly release: (nftId: string) => Promise<void>;
	readonly cleanupExpired: () => Promise<void>;
	readonly destroy: () => void;
} {
	const cleanupTimer = setInterval(() => {
		cleanupExpired().catch(() => {});
	}, 60_000);
	cleanupTimer.unref();

	const acquire = async (nftId: string, buyer: string, expirationMs: number): Promise<AcquireResult> => {
		const expiresAt = new Date(Date.now() + expirationMs).toISOString();

		await sql`DELETE FROM multisig_locks WHERE nft_id = ${nftId} AND expires_at < NOW()`;

		const [inserted] = await sql`
			INSERT INTO multisig_locks (nft_id, buyer, expires_at)
			VALUES (${nftId}, ${buyer}, ${expiresAt})
			ON CONFLICT (nft_id) DO UPDATE
				SET buyer = ${buyer}, expires_at = ${expiresAt}
				WHERE multisig_locks.buyer = ${buyer}
			RETURNING nft_id
		`;

		if (inserted) {
			return { acquired: true };
		}

		const [existing] = await sql`
			SELECT buyer, expires_at FROM multisig_locks WHERE nft_id = ${nftId}
		`;
		if (!existing) {
			return acquire(nftId, buyer, expirationMs);
		}

		const retryAfterMs = Math.max(0, new Date(String(existing.expires_at)).getTime() - Date.now());
		return { acquired: false, heldBy: String(existing.buyer), retryAfterMs };
	};

	const release = async (nftId: string): Promise<void> => {
		await sql`DELETE FROM multisig_locks WHERE nft_id = ${nftId}`;
	};

	const cleanupExpired = async (): Promise<void> => {
		await sql`DELETE FROM multisig_locks WHERE expires_at < NOW()`;
	};

	const destroy = (): void => {
		clearInterval(cleanupTimer);
	};

	return { acquire, release, cleanupExpired, destroy } as const;
}
