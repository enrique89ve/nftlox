import { sql } from "@/db/client.ts";

export async function seedCollection(id: string, seller: string): Promise<void> {
	await sql`
		INSERT INTO collections (
			id, name, symbol, creator, origin_dna,
			total_potential, max_instances,
			transferable, burnable, royalty_pct, royalty_recipient,
			block_num, tx_id, created_at
		)
		VALUES (
			${id}, ${"Coll " + id}, ${"SYM"}, ${seller}, ${"odna_" + id},
			100, 0,
			true, true, 0, NULL,
			90000000, ${("col_tx_" + id).padEnd(40, "0").slice(0, 40)}, NOW()
		)
		ON CONFLICT (id) DO NOTHING
	`;
}

export async function insertListedInstance(params: {
	readonly nftId: string;
	readonly collectionId: string;
	readonly seller: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly price?: string;
	/**
	 * Absolute ms timestamp for `listing_expires_at`. Defaults to now + 1h.
	 * Pass a past value (e.g. `Date.now() - 1000`) to simulate an expired
	 * listing that has not yet been cleared by the owner.
	 */
	readonly expiresAtMs?: number;
}): Promise<void> {
	const price = params.price ?? "10.000";
	const createdTx = `${params.nftId}_mint_tx`.padEnd(40, "0").slice(0, 40);
	const opId = `op_${params.nftId}`;
	const expiresAtIso = new Date(params.expiresAtMs ?? Date.now() + 3600_000).toISOString();
	await sql`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner, name,
			image_url, nft_dna, max_supply, distributed, reserved_supply,
			previous_owner, owner_operation_id, owner_action, owner_block_num,
			listing_id, listing_tx_id, listing_price, listing_currency,
			listing_expires_at, listing_marketplace,
			created_operation_id, created_block_num, created_tx_id, created_at
		) VALUES (
			${params.nftId}, ${params.collectionId}, 'instance', 'listed', 1, ${params.seller}, 'test',
			'https://img.example/i.png', ${"1".repeat(40)}, 0, 0, 0,
			NULL, ${opId}, 'mint', 90000001,
			${params.listingId}, ${params.listTxId}, ${price}, 'HIVE',
			${expiresAtIso}, NULL,
			${opId}, 90000001, ${createdTx}, NOW()
		)
	`;
}

/**
 * Deletes tables shared by most marketplace integration tests.
 * Does NOT delete `collections` — callers manage their own collection rows.
 */
export async function cleanCommonTables(): Promise<void> {
	await sql`DELETE FROM sales`;
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
	await sql`DELETE FROM orphaned_buys`;
	await sql`DELETE FROM l2_nodes`;
}
