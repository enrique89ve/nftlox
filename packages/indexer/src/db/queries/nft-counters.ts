// Counter tables (owner_nft_counts, collection_stats) are now maintained by
// the DB trigger `maintain_nft_counters` (see db/schema.sql). INSERT /
// DELETE / UPDATE-of-owner on `nfts` automatically adjusts the counters
// inside the same transaction, so no handler needs to call them.
//
// `adjustCollectionListed` is the only helper that survives: listed/unlisted
// state on `collection_stats` is not a function of nfts-row lifecycle, it's
// driven by marketplace handlers and stays app-level.

import { type Queryable } from "@/db/client.ts";

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
