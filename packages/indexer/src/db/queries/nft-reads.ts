import { sql, type Queryable } from "@/db/client.ts";
import { computeDataHash } from "@/protocol/index.ts";
import { parseOwnershipAction } from "./nft-types.ts";
import type {
	NftOwnerClaim,
	NftOwnershipProof,
	NftProcessingRow,
	NftWithRulesRow,
	SeedWithSchemaRow,
	NftListRow,
	NftKind,
} from "./nft-types.ts";

type NumericRowValue = number | string;

type NftOwnerClaimRow = Readonly<{
	readonly id: string;
	readonly owner: string;
	readonly previous_owner: string | null;
	readonly owner_action: string;
	readonly owner_operation_id: string;
	readonly owner_block_num: NumericRowValue;
}>;

type NftOwnershipProofRow = NftOwnerClaimRow & Readonly<{
	readonly created_operation_id: string;
	readonly created_block_num: NumericRowValue;
	readonly created_tx_id: string;
	readonly nft_type: NftKind;
	readonly seed_id: string | null;
	readonly instance_number: number | null;
	readonly instance_dna: string | null;
}>;

function toSafeInteger(value: NumericRowValue, fieldName: string): number {
	const numberValue = Number(value);
	if (!Number.isSafeInteger(numberValue)) {
		throw new Error(`Invalid ${fieldName}: ${value}`);
	}
	return numberValue;
}

async function buildOwnerClaimHash(claim: Omit<NftOwnerClaim, "claim_hash">): Promise<string> {
	return computeDataHash({
		id: claim.id,
		owner: claim.owner,
		previous_owner: claim.previous_owner,
		owner_action: claim.owner_action,
		owner_operation_id: claim.owner_operation_id,
		owner_block_num: claim.owner_block_num,
	});
}

async function normalizeOwnerClaim(row: NftOwnerClaimRow): Promise<NftOwnerClaim> {
	const ownerAction = parseOwnershipAction(row.owner_action);
	if (!ownerAction) {
		throw new Error(`Invalid owner_action for NFT ${row.id}: ${row.owner_action}`);
	}
	const claim = {
		id: row.id,
		owner: row.owner,
		previous_owner: row.previous_owner,
		owner_action: ownerAction,
		owner_operation_id: row.owner_operation_id,
		owner_block_num: toSafeInteger(row.owner_block_num, "owner_block_num"),
	};
	return {
		...claim,
		claim_hash: await buildOwnerClaimHash(claim),
	};
}

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
			n.max_supply, n.distributed, n.supply_exhausted,
			n.seed_id, n.instance_number,
			n.previous_owner, n.owner_operation_id, n.owner_action, n.owner_block_num::int AS owner_block_num,
			n.created_tx_id AS tx_id, n.created_at,
			co.signer AS minted_by,
			n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency,
			n.listing_expires_at, n.listing_marketplace,
			s.created_tx_id AS seed_tx_id,
			CASE WHEN n.listing_expires_at IS NOT NULL AND n.listing_expires_at <= NOW()
				THEN true ELSE false
			END AS listing_expired
		FROM nfts n
		LEFT JOIN nfts s ON s.id = n.seed_id
		LEFT JOIN confirmed_operations co ON co.operation_id = n.created_operation_id
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

export async function getNftOwnerClaim(id: string): Promise<NftOwnerClaim | null> {
	const [row] = await sql<NftOwnerClaimRow[]>`
		SELECT
			n.id,
			n.owner,
			n.previous_owner,
			n.owner_action,
			n.owner_operation_id,
			n.owner_block_num
		FROM nfts n
		WHERE n.id = ${id}
	`;
	if (!row) return null;
	return normalizeOwnerClaim(row);
}

export async function getNftOwnershipProof(id: string): Promise<NftOwnershipProof | null> {
	const [row] = await sql<NftOwnershipProofRow[]>`
		SELECT
			n.id,
			n.owner,
			n.previous_owner,
			n.owner_operation_id,
			n.owner_action,
			n.owner_block_num,
			n.created_operation_id,
			n.created_block_num,
			n.created_tx_id,
			n.nft_type,
			n.seed_id,
			n.instance_number,
			n.instance_dna
		FROM nfts n
		WHERE n.id = ${id}
	`;
	if (!row) return null;
	const ownerClaim = await normalizeOwnerClaim(row);
	return {
		...ownerClaim,
		previous_owner: row.previous_owner,
		created_operation_id: row.created_operation_id,
		created_block_num: toSafeInteger(row.created_block_num, "created_block_num"),
		created_tx_id: row.created_tx_id,
		nft_type: row.nft_type,
		seed_id: row.seed_id,
		instance_number: row.instance_number,
		instance_dna: row.instance_dna,
	};
}

export async function nftExists(id: string, txn: Queryable = sql): Promise<boolean> {
	const [row] = await txn`SELECT 1 FROM nfts WHERE id = ${id}`;
	return !!row;
}

export async function getNftForProcessing(id: string, txn: Queryable = sql): Promise<NftProcessingRow | null> {
	const [row] = await txn<NftProcessingRow[]>`
		SELECT id, owner, status, nft_type, name, seed_id, max_supply, distributed, reserved_supply,
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
			n.id, n.owner, n.status, n.nft_type, n.name, n.seed_id, n.max_supply, n.distributed,
			n.reserved_supply,
			n.collection_id, n.instance_dna, n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency,
			n.listing_expires_at, n.listing_marketplace, n.data_operation_id, n.created_tx_id,
			c.creator, c.transferable, c.burnable, c.royalty_pct, c.royalty_recipient,
			s.created_tx_id AS seed_created_tx_id
		FROM nfts n
		JOIN collections c ON c.id = n.collection_id
		LEFT JOIN nfts s ON s.id = n.seed_id
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

/** Seed summary in NftListRow shape — used by compact instances endpoint. */
export async function getSeedSummary(id: string): Promise<NftListRow | null> {
	const [row] = await sql<NftListRow[]>`
		SELECT
			id, collection_id, nft_type, status, edition, owner,
			name, image_url, origin_dna, immutable_data,
			instance_dna,
			seed_id, instance_number, NULL::text AS seed_tx_id,
			max_supply, distributed, supply_exhausted,
			schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num::int AS owner_block_num,
			listing_id, listing_tx_id, listing_price, listing_currency, listing_expires_at, listing_marketplace, created_at
		FROM nfts WHERE id = ${id} AND nft_type = 'seed'
	`;
	return row ?? null;
}

export async function getSeedWithSchemaForUpdate(id: string, txn: Queryable): Promise<SeedWithSchemaRow | null> {
	const [row] = await txn<SeedWithSchemaRow[]>`
		SELECT n.id, n.owner, n.status, n.nft_type, n.name, n.seed_id, n.max_supply, n.distributed,
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
