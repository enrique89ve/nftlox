// ============ INTERNAL COUNTER HELPERS ============
// Counter tables (owner_nft_counts, collection_stats) are maintained explicitly
// by the application — NOT by DB triggers — for correctness under concurrency
// and full visibility in handler code. All mutations that affect counts MUST
// pass the corresponding context so counters stay in sync within the same txn.

import { type Queryable } from "@/db/client.ts";
import type { NftKind } from "./nft-types.ts";

export async function adjustOwnerNftCount(
	owner: string,
	nftType: NftKind,
	delta: 1 | -1,
	txn: Queryable,
): Promise<void> {
	const seedDelta     = nftType === "seed"     ? delta : 0;
	const instanceDelta = nftType === "instance" ? delta : 0;

	if (delta === -1) {
		const result = await txn`
			UPDATE owner_nft_counts SET
				total     = total     + ${delta},
				seeds     = seeds     + ${seedDelta},
				instances = instances + ${instanceDelta}
			WHERE owner = ${owner}
		`;
		if (result.count === 0) {
			throw new Error(`Owner NFT count missing for ${owner}`);
		}
		return;
	}

	await txn`
		INSERT INTO owner_nft_counts (owner, total, seeds, instances)
		VALUES (${owner}, ${delta}, ${seedDelta}, ${instanceDelta})
		ON CONFLICT (owner) DO UPDATE SET
			total     = owner_nft_counts.total     + ${delta},
			seeds     = owner_nft_counts.seeds     + ${seedDelta},
			instances = owner_nft_counts.instances + ${instanceDelta}
	`;
}

export async function recordCollectionMint(
	collectionId: string,
	nftType: NftKind,
	txn: Queryable,
): Promise<void> {
	const seedInc     = nftType === "seed"     ? 1 : 0;
	const instanceInc = nftType === "instance" ? 1 : 0;
	await txn`
		INSERT INTO collection_stats (collection_id, total, seeds, instances, listed, burned)
		VALUES (${collectionId}, 1, ${seedInc}, ${instanceInc}, 0, 0)
		ON CONFLICT (collection_id) DO UPDATE SET
			total     = collection_stats.total     + 1,
			seeds     = collection_stats.seeds     + ${seedInc},
			instances = collection_stats.instances + ${instanceInc}
	`;
}

export async function adjustCollectionListed(
	collectionId: string,
	delta: 1 | -1,
	txn: Queryable,
): Promise<void> {
	await txn`
		UPDATE collection_stats SET listed = listed + ${delta}
		WHERE collection_id = ${collectionId}
	`;
}

export async function recordCollectionBurn(collectionId: string, nftType: NftKind, txn: Queryable): Promise<void> {
	const seedDec     = nftType === "seed"     ? 1 : 0;
	const instanceDec = nftType === "instance" ? 1 : 0;
	await txn`
		UPDATE collection_stats
		SET burned = burned + 1,
		    total = total - 1,
		    seeds = seeds - ${seedDec},
		    instances = instances - ${instanceDec}
		WHERE collection_id = ${collectionId}
	`;
}
