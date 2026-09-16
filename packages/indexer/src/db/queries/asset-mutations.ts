import { sql, toJsonb, type Queryable } from "@/db/client.ts";
import type { InsertAssetParams, OwnerChangeCtx, BurnCtx, ListingCtx, AssetStatus } from "./asset-types.ts";
import { ASSET_KIND_INSTANCE, ASSET_STATUS_ACTIVE, ASSET_STATUS_LISTED, ASSET_STATUS_PENDING_SALE } from "./asset-types.ts";
import { adjustCollectionListed } from "./asset-counters.ts";
import { queueStateRootDelta, parseAssetStateRow } from "./state-root.ts";
import { getStateRootBuffer } from "@/db/client.ts";
import type { AssetStateRow } from "@/utils/state-root-hash.ts";

// Reads the SPV-visible fields that contribute to the state-root hash. Must
// be called with the same txn that is about to mutate the row, and BEFORE
// the UPDATE/DELETE, otherwise we'd XOR a stale/already-modified snapshot.
async function readStateRow(assetId: string, txn: Queryable): Promise<AssetStateRow | null> {
	const [row] = await txn`
		SELECT id, owner, previous_owner, owner_action, owner_operation_id, owner_block_num
		FROM assets
		WHERE id = ${assetId}
		FOR UPDATE
	`;
	if (!row) return null;
	return parseAssetStateRow(row as Record<string, unknown>);
}

export type MarketplaceListingCleanupResult = Readonly<{
	readonly clearedListings: number;
	readonly reconciledCollections: number;
}>;

export async function insertAsset(params: InsertAssetParams, txn: Queryable = sql): Promise<boolean> {
	const result = await txn`
		INSERT INTO assets (
			id, collection_id, asset_type, status, edition, owner,
			asset_dna,
			name, image_url,
			max_supply, distributed,
			seed_id, instance_number, art_id,
			immutable_data,
			data_operation_id, data_hash,
			schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num,
			created_operation_id, created_block_num, created_tx_id, created_at
		) VALUES (
			${params.id}, ${params.collectionId}, ${params.assetType},
			${params.status ?? ASSET_STATUS_ACTIVE}, ${params.edition}, ${params.owner},
			${params.assetDna},
			${params.name}, ${params.imageUrl},
			${params.maxSupply}, ${params.distributed ?? 0},
			${params.seedId}, ${params.instanceNumber}, ${params.artId},
			${toJsonb(params.immutableData)},
			${params.dataOperationId}, ${params.dataHash},
			${params.schemaVersion ?? null},
			${null},
			${params.ownerOperationId},
			${params.ownerAction},
			${params.ownerBlockNum},
			${params.createdOperationId},
			${params.createdBlockNum}, ${params.createdTxId}, ${params.createdAt}
		)
		ON CONFLICT (id) DO NOTHING
	`;
	if (result.count > 0) {
		// Counters (owner_asset_counts, collection_stats) are maintained by the
		// AFTER INSERT trigger `maintain_asset_counters`. The state-root delta
		// stays here because it lives in a txn-local buffer, not in SQL, so
		// no trigger equivalent exists.
		const newRow: AssetStateRow = {
			id: params.id,
			owner: params.owner,
			previous_owner: null,
			owner_action: params.ownerAction,
			owner_operation_id: params.ownerOperationId,
			owner_block_num: params.ownerBlockNum,
		};
		queueStateRootDelta(getStateRootBuffer(txn), {
			type: "insert",
			newRow,
			blockNum: params.ownerBlockNum,
		});
	}
	return result.count > 0;
}

export async function updateAssetOwner(
	assetId: string,
	newOwner: string,
	ownerOperationId: string,
	ctx: OwnerChangeCtx,
	txn: Queryable = sql,
): Promise<void> {
	// Read old SPV row under FOR UPDATE before mutating, so the state-root
	// delta is computed against the exact pre-image of the UPDATE. Any crash
	// between here and the buffered flush rolls back the entire batch.
	const oldRow = await readStateRow(assetId, txn);
	if (!oldRow) throw new Error(`updateAssetOwner: asset ${assetId} not found`);
	await txn`
		UPDATE assets
		SET owner = ${newOwner}, status = ${ASSET_STATUS_ACTIVE},
		    previous_owner = ${ctx.oldOwner},
		    owner_operation_id = ${ownerOperationId},
		    owner_action = ${ctx.ownerAction},
		    owner_block_num = ${ctx.ownerBlockNum},
		    listing_id = NULL, listing_tx_id = NULL,
		    listing_price = NULL, listing_currency = NULL, listing_expires_at = NULL, listing_marketplace = NULL,
		    sale_buyer = NULL, sale_settlement_node = NULL,
		    sale_expires_block = NULL, sale_commitment_op_tx_id = NULL, sale_commitment_buy_tx_hash = NULL
		WHERE id = ${assetId}
	`;
	// Queue the delta BEFORE counter updates. See insertAsset for rationale —
	// any counter failure between here and the state-root flush would leave
	// the committed assets row without a corresponding delta.
	const newRow: AssetStateRow = {
		id: assetId,
		owner: newOwner,
		previous_owner: ctx.oldOwner,
		owner_action: ctx.ownerAction,
		owner_operation_id: ownerOperationId,
		owner_block_num: ctx.ownerBlockNum,
	};
	queueStateRootDelta(getStateRootBuffer(txn), {
		type: "update",
		oldRow,
		newRow,
		blockNum: ctx.ownerBlockNum,
	});
	// Owner counters (both sides of the ownership move) are applied by the
	// AFTER UPDATE OF owner trigger `maintain_asset_counters`. It raises
	// `"Owner Asset count missing for …"` when OLD.owner has no counter row —
	// exactly the error adjustOwnerAssetCount(-1) used to throw.
	if (ctx.wasListed) {
		await adjustCollectionListed(ctx.collectionId, -1, txn);
	}
}

export async function updateAssetStatus(assetId: string, status: AssetStatus, txn: Queryable = sql) {
	await txn`UPDATE assets SET status = ${status} WHERE id = ${assetId}`;
}

export async function hardDeleteAsset(
	assetId: string,
	burnedBy: string,
	txId: string,
	operationId: string,
	ctx: BurnCtx,
	txn: Queryable = sql,
): Promise<void> {
	// Lock + read SPV snapshot before DELETE so we XOR out the exact hash
	// that was previously XORed in on insert/update. Without FOR UPDATE, a
	// racing handler could delete the row first and leave us with nothing
	// to un-hash — that's the failure mode the state-root tests call out.
	const oldRow = await readStateRow(assetId, txn);
	if (!oldRow) throw new Error(`hardDeleteAsset: asset ${assetId} not found`);
	await txn`
		INSERT INTO burned_assets (id, collection_id, burned_by, tx_id, operation_id, created_at)
		VALUES (${assetId}, ${ctx.collectionId}, ${burnedBy}, ${txId}, ${operationId}, ${ctx.createdAt})
		ON CONFLICT (id) DO NOTHING
	`;
	await txn`DELETE FROM assets WHERE id = ${assetId}`;
	// Counter decrement and `collection_stats.burned` increment happen in
	// the AFTER DELETE trigger `maintain_asset_counters`.
	queueStateRootDelta(getStateRootBuffer(txn), {
		type: "delete",
		oldRow,
		blockNum: ctx.blockNum,
	});
}

export async function updateAssetListing(
	assetId: string,
	price: number | null,
	currency: string | null,
	expiresAt: number | null,
	marketplace: string | null,
	listingId: string | null,
	listingTxId: string | null,
	ctx: ListingCtx,
	txn: Queryable = sql,
): Promise<void> {
	if (price === null) {
		await txn`
			UPDATE assets
			SET status = ${ASSET_STATUS_ACTIVE},
			    listing_id = NULL, listing_tx_id = NULL,
			    listing_price = NULL, listing_currency = NULL, listing_expires_at = NULL, listing_marketplace = NULL
			WHERE id = ${assetId}
		`;
		if (ctx.wasListed) {
			await adjustCollectionListed(ctx.collectionId, -1, txn);
		}
	} else {
		const expiresIso = expiresAt ? new Date(expiresAt).toISOString() : null;
		await txn`
			UPDATE assets
			SET status = ${ASSET_STATUS_LISTED},
			    listing_id = ${listingId}, listing_tx_id = ${listingTxId},
			    listing_price = ${price}, listing_currency = ${currency},
			    listing_expires_at = ${expiresIso}, listing_marketplace = ${marketplace}
			WHERE id = ${assetId}
		`;
		if (!ctx.wasListed) {
			await adjustCollectionListed(ctx.collectionId, 1, txn);
		}
	}
}

/**
 * Returns every Asset whose `sale_expires_block < currentBlock` back to
 * `status='listed'`, clearing the five sale_* snapshot columns. Called by
 * the sync engine before routing any op at `currentBlock`, so every handler
 * observes a post-sweep world and can never settle a stale lock.
 *
 * `collection_stats.listed` is intentionally NOT touched: per protocol
 * §10.5 the counter already includes both `listed` and `pending_sale`
 * rows, so the listed↔pending_sale transition is counter-invariant.
 *
 * Runs under the batch transaction — rollback of the batch rolls back the
 * sweep. The partial index `idx_assets_sale_expires` keeps this at ~0 cost
 * when no rows are due.
 */
export async function sweepExpiredBuyCommitments(currentBlock: number, txn: Queryable): Promise<number> {
	const result = await txn`
		UPDATE assets
		SET status = ${ASSET_STATUS_LISTED},
		    sale_buyer = NULL, sale_settlement_node = NULL,
		    sale_expires_block = NULL, sale_commitment_op_tx_id = NULL, sale_commitment_buy_tx_hash = NULL
		WHERE status = ${ASSET_STATUS_PENDING_SALE}
		  AND sale_expires_block < ${currentBlock}
	`;
	return result.count;
}

export async function incrementDistributedBy(seedId: string, quantity: number, txn: Queryable = sql) {
	await txn`UPDATE assets SET distributed = distributed + ${quantity} WHERE id = ${seedId}`;
}

export async function updateAssetDataRef(
	assetId: string,
	dataHash: string,
	dataOperationId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE assets
		SET data_hash = ${dataHash},
			data_operation_id = ${dataOperationId}
		WHERE id = ${assetId}
	`;
}

/**
 * Repairs structurally impossible marketplace rows without evaluating expiry.
 *
 * Listing expiration is chain-time state and must stay in the block processing
 * path (`op.timestamp`) or in read filters. Using `NOW()` here would let an API
 * or delayed indexer boot mutate a listing before an older valid buy operation
 * has been processed.
 */
export async function cleanupInvalidMarketplaceListings(
	txn: Queryable = sql,
): Promise<MarketplaceListingCleanupResult> {
	const cleared = await txn`
		UPDATE assets
		SET status = ${ASSET_STATUS_ACTIVE},
		    listing_id = NULL, listing_tx_id = NULL,
		    listing_price = NULL, listing_currency = NULL,
		    listing_expires_at = NULL, listing_marketplace = NULL
		WHERE status = ${ASSET_STATUS_LISTED}
			AND asset_type <> ${ASSET_KIND_INSTANCE}
	`;

	const reconciled = await txn`
		WITH marketplace_rows AS (
			SELECT
				cs.collection_id,
				COUNT(n.id)::int AS listed
			FROM collection_stats cs
			LEFT JOIN assets n ON n.collection_id = cs.collection_id
				AND n.asset_type = ${ASSET_KIND_INSTANCE}
				AND n.status IN (${ASSET_STATUS_LISTED}, ${ASSET_STATUS_PENDING_SALE})
			GROUP BY cs.collection_id
		)
		UPDATE collection_stats cs
		SET listed = marketplace_rows.listed
		FROM marketplace_rows
		WHERE cs.collection_id = marketplace_rows.collection_id
			AND cs.listed <> marketplace_rows.listed
	`;

	return {
		clearedListings: cleared.count,
		reconciledCollections: reconciled.count,
	};
}
