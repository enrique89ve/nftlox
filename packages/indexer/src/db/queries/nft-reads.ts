import { sql, type Queryable } from "@/db/client.ts";
import type { NftProcessingRow, NftWithRulesRow, SeedWithSchemaRow } from "./nft-types.ts";

export async function getNftById(id: string) {
	const [row] = await sql`
		SELECT
			n.id, n.collection_id, n.nft_type, n.status, n.edition, n.owner,
			COALESCE(NULLIF(n.name, ''), s.name) AS name,
			COALESCE(n.image_url, s.image_url) AS image_url,
			COALESCE(n.origin_dna, s.origin_dna) AS origin_dna,
			n.instance_dna,
			COALESCE(n.immutable_data, s.immutable_data) AS immutable_data,
			n.data_hash, n.schema_version,
			n.max_replicas, n.distributed, n.supply_exhausted,
			n.seed_id, n.instance_number, n.original_id,
			n.previous_owner, n.owner_operation_id, n.created_tx_id AS tx_id, n.created_at,
			n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency,
			n.listing_expires_at, n.listing_marketplace,
			s.created_tx_id AS seed_tx_id,
			CASE WHEN n.listing_expires_at IS NOT NULL AND n.listing_expires_at <= NOW()
				THEN true ELSE false
			END AS listing_expired
		FROM nfts n
		LEFT JOIN nfts s ON s.id = n.seed_id
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

export async function getNftOwnershipProof(id: string) {
	const [row] = await sql`
		SELECT
			n.id,
			n.owner,
			n.previous_owner,
			n.owner_operation_id,
			n.created_tx_id,
			n.nft_type,
			n.seed_id,
			n.instance_number,
			n.instance_dna
		FROM nfts n
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

export async function nftExists(id: string, txn: Queryable = sql): Promise<boolean> {
	const [row] = await txn`SELECT 1 FROM nfts WHERE id = ${id}`;
	return !!row;
}

export async function getNftForProcessing(id: string, txn: Queryable = sql): Promise<NftProcessingRow | null> {
	const [row] = await txn<NftProcessingRow[]>`
		SELECT id, owner, status, nft_type, name, seed_id, max_replicas, distributed, reserved_supply,
		       collection_id, instance_dna,
		       listing_id, listing_tx_id, listing_price, listing_currency, listing_expires_at, listing_marketplace, data_operation_id
		FROM nfts WHERE id = ${id}
	`;
	return row ?? null;
}

export async function getNftWithCollectionRules(
	id: string,
	txn: Queryable = sql,
): Promise<NftWithRulesRow | null> {
	const [row] = await txn<NftWithRulesRow[]>`
		SELECT
			n.id, n.owner, n.status, n.nft_type, n.name, n.seed_id, n.max_replicas, n.distributed,
			n.reserved_supply,
			n.collection_id, n.instance_dna, n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency,
			n.listing_expires_at, n.listing_marketplace, n.data_operation_id, n.created_tx_id,
			c.creator, c.transferable, c.burnable, c.replicable, c.royalty_pct, c.royalty_recipient,
			s.created_tx_id AS seed_created_tx_id
		FROM nfts n
		JOIN collections c ON c.id = n.collection_id
		LEFT JOIN nfts s ON s.id = n.seed_id
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

export async function getSeedWithSchemaForUpdate(id: string, txn: Queryable): Promise<SeedWithSchemaRow | null> {
	const [row] = await txn<SeedWithSchemaRow[]>`
		SELECT n.id, n.owner, n.status, n.nft_type, n.name, n.seed_id, n.max_replicas, n.distributed,
			n.reserved_supply,
			n.collection_id, n.instance_dna, n.origin_dna, n.image_url, n.created_tx_id,
			c.schema, c.schema_version
		FROM nfts n
		JOIN collections c ON c.id = n.collection_id
		WHERE n.id = ${id}
		FOR UPDATE OF n
	`;
	return row ?? null;
}
