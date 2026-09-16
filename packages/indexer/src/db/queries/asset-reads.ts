import { sql, type Queryable } from "@/db/client.ts";
import { computeDataHash } from "@/protocol/index.ts";
import { parseOwnershipAction } from "./asset-types.ts";
import type {
	AssetOwnerClaim,
	AssetOwnershipProof,
	AssetProcessingRow,
	AssetWithRulesRow,
	SeedWithSchemaRow,
	AssetListRow,
	AssetKind,
} from "./asset-types.ts";

// postgres.js sql.array needs the PG type OID. 25 = TEXT, used for id lists.
const PG_TEXT_OID = 25;

type NumericRowValue = number | string;

type AssetOwnerClaimRow = Readonly<{
	readonly id: string;
	readonly owner: string;
	readonly previous_owner: string | null;
	readonly owner_action: string;
	readonly owner_operation_id: string;
	readonly owner_block_num: NumericRowValue;
}>;

type AssetOwnershipProofRow = AssetOwnerClaimRow & Readonly<{
	readonly created_operation_id: string;
	readonly created_block_num: NumericRowValue;
	readonly created_tx_id: string;
	readonly asset_type: AssetKind;
	readonly seed_id: string | null;
	readonly instance_number: number | null;
	readonly asset_dna: string | null;
	readonly collection_id: string;
	readonly collection_created_block_num: NumericRowValue;
	readonly collection_created_tx_id: string;
}>;

function toSafeInteger(value: NumericRowValue, fieldName: string): number {
	const numberValue = Number(value);
	if (!Number.isSafeInteger(numberValue)) {
		throw new Error(`Invalid ${fieldName}: ${value}`);
	}
	return numberValue;
}

async function buildOwnerClaimHash(claim: Omit<AssetOwnerClaim, "claim_hash">): Promise<string> {
	return computeDataHash({
		id: claim.id,
		owner: claim.owner,
		previous_owner: claim.previous_owner,
		owner_action: claim.owner_action,
		owner_operation_id: claim.owner_operation_id,
		owner_block_num: claim.owner_block_num,
	});
}

async function normalizeOwnerClaim(row: AssetOwnerClaimRow): Promise<AssetOwnerClaim> {
	const ownerAction = parseOwnershipAction(row.owner_action);
	if (!ownerAction) {
		throw new Error(`Invalid owner_action for Asset ${row.id}: ${row.owner_action}`);
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

export async function getAssetById(id: string) {
	const [row] = await sql`
		SELECT
			n.id, n.collection_id, n.asset_type, n.status, n.edition, n.owner,
			COALESCE(NULLIF(n.name, ''), s.name) AS name,
			COALESCE(n.image_url, s.image_url) AS image_url,
			c.origin_dna AS origin_dna,
			n.asset_dna,
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
		FROM assets n
		JOIN collections c ON c.id = n.collection_id
		LEFT JOIN assets s ON s.id = n.seed_id
		LEFT JOIN confirmed_operations co ON co.operation_id = n.created_operation_id
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

/**
 * Batch read variant of getAssetById. Single round-trip via `id = ANY($1)`.
 * Row shape matches getAssetById so callers can treat single/batch uniformly.
 * Missing ids are NOT represented here — the route layer diffs input vs
 * returned rows and emits `missing: string[]` alongside the items.
 */
export async function getAssetsByIds(ids: readonly string[]) {
	if (ids.length === 0) return [];
	return sql`
		SELECT
			n.id, n.collection_id, n.asset_type, n.status, n.edition, n.owner,
			COALESCE(NULLIF(n.name, ''), s.name) AS name,
			COALESCE(n.image_url, s.image_url) AS image_url,
			c.origin_dna AS origin_dna,
			n.asset_dna,
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
		FROM assets n
		JOIN collections c ON c.id = n.collection_id
		LEFT JOIN assets s ON s.id = n.seed_id
		LEFT JOIN confirmed_operations co ON co.operation_id = n.created_operation_id
		WHERE n.id = ANY(${sql.array([...ids], PG_TEXT_OID)})
	`;
}

export async function getAssetOwnerClaim(id: string): Promise<AssetOwnerClaim | null> {
	const [row] = await sql<AssetOwnerClaimRow[]>`
		SELECT
			n.id,
			n.owner,
			n.previous_owner,
			n.owner_action,
			n.owner_operation_id,
			n.owner_block_num
		FROM assets n
		WHERE n.id = ${id}
	`;
	if (!row) return null;
	return normalizeOwnerClaim(row);
}

export async function getAssetOwnershipProof(id: string): Promise<AssetOwnershipProof | null> {
	const [row] = await sql<AssetOwnershipProofRow[]>`
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
			n.asset_type,
			n.seed_id,
			n.instance_number,
			n.asset_dna,
			n.collection_id,
			c.block_num AS collection_created_block_num,
			c.tx_id AS collection_created_tx_id
		FROM assets n
		JOIN collections c ON c.id = n.collection_id
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
		asset_type: row.asset_type,
		seed_id: row.seed_id,
		instance_number: row.instance_number,
		asset_dna: row.asset_dna,
		collection_id: row.collection_id,
		collection_created_block_num: toSafeInteger(row.collection_created_block_num, "collection_created_block_num"),
		collection_created_tx_id: row.collection_created_tx_id,
	};
}

export async function assetExists(id: string, txn: Queryable = sql): Promise<boolean> {
	const [row] = await txn`SELECT 1 FROM assets WHERE id = ${id}`;
	return !!row;
}

/**
 * Returns true when `id` was previously burned (exists in burned_assets). Used by
 * mint / bulk_distribute to prevent resurrection: once a deterministic id has
 * been retired, the same id must never be re-created — even if the contender
 * payload looks otherwise canonical. The burned_assets table is append-only, so
 * this check is O(1) via the PK index.
 */
export async function isBurnedId(id: string, txn: Queryable = sql): Promise<boolean> {
	const [row] = await txn`SELECT 1 FROM burned_assets WHERE id = ${id}`;
	return !!row;
}

export async function getAssetForProcessing(id: string, txn: Queryable = sql): Promise<AssetProcessingRow | null> {
	const [row] = await txn<AssetProcessingRow[]>`
		SELECT id, owner, status, asset_type, name, seed_id, max_supply, distributed, reserved_supply,
		       collection_id, asset_dna,
		       listing_id, listing_tx_id, listing_price, listing_currency, listing_expires_at, listing_marketplace,
		       sale_buyer, sale_settlement_node, sale_expires_block, sale_commitment_op_tx_id, sale_commitment_buy_tx_hash,
		       data_operation_id
		FROM assets WHERE id = ${id}
	`;
	return row ?? null;
}

export async function getAssetForProcessingForUpdate(id: string, txn: Queryable): Promise<AssetProcessingRow | null> {
	const [row] = await txn<AssetProcessingRow[]>`
		SELECT id, owner, status, asset_type, name, seed_id, max_supply, distributed, reserved_supply,
		       collection_id, asset_dna,
		       listing_id, listing_tx_id, listing_price, listing_currency, listing_expires_at, listing_marketplace,
		       sale_buyer, sale_settlement_node, sale_expires_block, sale_commitment_op_tx_id, sale_commitment_buy_tx_hash,
		       data_operation_id
		FROM assets WHERE id = ${id}
		FOR UPDATE
	`;
	return row ?? null;
}

export async function getAssetWithCollectionRules(
	id: string,
	txn: Queryable = sql,
): Promise<AssetWithRulesRow | null> {
	const [row] = await txn<AssetWithRulesRow[]>`
		SELECT
			n.id, n.owner, n.status, n.asset_type, n.name, n.seed_id, n.max_supply, n.distributed,
			n.reserved_supply,
			n.collection_id, n.asset_dna, n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency,
			n.listing_expires_at, n.listing_marketplace,
			n.sale_buyer, n.sale_settlement_node, n.sale_expires_block, n.sale_commitment_op_tx_id, n.sale_commitment_buy_tx_hash,
			n.data_operation_id, n.created_tx_id,
			c.creator, c.transferable, c.burnable, c.royalty_pct, c.royalty_recipient,
			s.created_tx_id AS seed_created_tx_id
		FROM assets n
		JOIN collections c ON c.id = n.collection_id
		LEFT JOIN assets s ON s.id = n.seed_id
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

export async function getAssetWithCollectionRulesForUpdate(
	id: string,
	txn: Queryable,
): Promise<AssetWithRulesRow | null> {
	const [row] = await txn<AssetWithRulesRow[]>`
		SELECT
			n.id, n.owner, n.status, n.asset_type, n.name, n.seed_id, n.max_supply, n.distributed,
			n.reserved_supply,
			n.collection_id, n.asset_dna, n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency,
			n.listing_expires_at, n.listing_marketplace,
			n.sale_buyer, n.sale_settlement_node, n.sale_expires_block, n.sale_commitment_op_tx_id, n.sale_commitment_buy_tx_hash,
			n.data_operation_id, n.created_tx_id,
			c.creator, c.transferable, c.burnable, c.royalty_pct, c.royalty_recipient,
			s.created_tx_id AS seed_created_tx_id
		FROM assets n
		JOIN collections c ON c.id = n.collection_id
		LEFT JOIN assets s ON s.id = n.seed_id
		WHERE n.id = ${id}
		FOR UPDATE OF n
	`;
	return row ?? null;
}

/** Seed summary in AssetListRow shape — used by compact instances endpoint. */
export async function getSeedSummary(id: string): Promise<AssetListRow | null> {
	const [row] = await sql<AssetListRow[]>`
		SELECT
			n.id, n.collection_id, n.asset_type, n.status, n.edition, n.owner,
			n.name, n.image_url, c.origin_dna AS origin_dna, n.immutable_data,
			n.asset_dna,
			n.seed_id, n.instance_number, NULL::text AS seed_tx_id,
			n.max_supply, n.distributed, n.supply_exhausted,
			n.schema_version, n.previous_owner, n.owner_operation_id, n.owner_action, n.owner_block_num::int AS owner_block_num,
			n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency, n.listing_expires_at, n.listing_marketplace, n.created_at
		FROM assets n
		JOIN collections c ON c.id = n.collection_id
		WHERE n.id = ${id} AND n.asset_type = 'seed'
	`;
	return row ?? null;
}

export async function getSeedWithSchemaForUpdate(id: string, txn: Queryable): Promise<SeedWithSchemaRow | null> {
	const [row] = await txn<SeedWithSchemaRow[]>`
		SELECT n.id, n.owner, n.status, n.asset_type, n.name, n.seed_id, n.max_supply, n.distributed,
			n.reserved_supply,
			n.collection_id, n.asset_dna, c.origin_dna, n.image_url, n.created_tx_id,
			c.schema, c.schema_version, c.creator, c.max_instances
		FROM assets n
		JOIN collections c ON c.id = n.collection_id
		WHERE n.id = ${id}
		FOR UPDATE OF n
	`;
	return row ?? null;
}
