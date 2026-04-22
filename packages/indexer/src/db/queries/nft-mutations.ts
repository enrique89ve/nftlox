import { sql, toJsonb, type Queryable } from "@/db/client.ts";
import type { InsertNftParams, OwnerChangeCtx, BurnCtx, ListingCtx, NftStatus } from "./nft-types.ts";
import { NFT_KIND_INSTANCE, NFT_STATUS_ACTIVE, NFT_STATUS_LISTED, NFT_STATUS_PENDING_SALE } from "./nft-types.ts";
import { adjustOwnerNftCount, recordCollectionMint, adjustCollectionListed, recordCollectionBurn } from "./nft-counters.ts";
import { queueStateRootDelta, parseNftStateRow } from "./state-root.ts";
import { getStateRootBuffer } from "@/db/client.ts";
import type { NftStateRow } from "@/utils/state-root-hash.ts";

// Reads the SPV-visible fields that contribute to the state-root hash. Must
// be called with the same txn that is about to mutate the row, and BEFORE
// the UPDATE/DELETE, otherwise we'd XOR a stale/already-modified snapshot.
async function readStateRow(nftId: string, txn: Queryable): Promise<NftStateRow | null> {
	const [row] = await txn`
		SELECT id, owner, previous_owner, owner_action, owner_operation_id, owner_block_num
		FROM nfts
		WHERE id = ${nftId}
		FOR UPDATE
	`;
	if (!row) return null;
	return parseNftStateRow(row as Record<string, unknown>);
}

export type MarketplaceListingCleanupResult = Readonly<{
	readonly clearedListings: number;
	readonly reconciledCollections: number;
}>;

export async function insertNft(params: InsertNftParams, txn: Queryable = sql): Promise<boolean> {
	const result = await txn`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner,
			origin_dna, instance_dna,
			name, image_url,
			max_supply, distributed,
			seed_id, instance_number, art_id,
			immutable_data,
			data_operation_id, data_hash,
			schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num,
			created_operation_id, created_block_num, created_tx_id, created_at
		) VALUES (
			${params.id}, ${params.collectionId}, ${params.nftType},
			${params.status ?? NFT_STATUS_ACTIVE}, ${params.edition}, ${params.owner},
			${params.originDna}, ${params.instanceDna},
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
		// Queue the state-root delta BEFORE any counter update. Counters
		// (adjustOwnerNftCount, recordCollectionMint) can throw — if they do,
		// routeOperation swallows the error and withTransaction still commits.
		// If the delta were queued AFTER the counters, a counter-update failure
		// would leave the nfts row committed with no matching state-root delta
		// → silent divergence. queueStateRootDelta is a sync memory op and
		// cannot fail, so moving it first closes that window.
		const newRow: NftStateRow = {
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
		await adjustOwnerNftCount(params.owner, params.nftType, 1, txn);
		await recordCollectionMint(params.collectionId, params.nftType, txn);
	}
	return result.count > 0;
}

export async function updateNftOwner(
	nftId: string,
	newOwner: string,
	ownerOperationId: string,
	ctx: OwnerChangeCtx,
	txn: Queryable = sql,
): Promise<void> {
	// Read old SPV row under FOR UPDATE before mutating, so the state-root
	// delta is computed against the exact pre-image of the UPDATE. Any crash
	// between here and the buffered flush rolls back the entire batch.
	const oldRow = await readStateRow(nftId, txn);
	if (!oldRow) throw new Error(`updateNftOwner: nft ${nftId} not found`);
	await txn`
		UPDATE nfts
		SET owner = ${newOwner}, status = ${NFT_STATUS_ACTIVE},
		    previous_owner = ${ctx.oldOwner},
		    owner_operation_id = ${ownerOperationId},
		    owner_action = ${ctx.ownerAction},
		    owner_block_num = ${ctx.ownerBlockNum},
		    listing_id = NULL, listing_tx_id = NULL,
		    listing_price = NULL, listing_currency = NULL, listing_expires_at = NULL, listing_marketplace = NULL,
		    sale_buyer = NULL, sale_settlement_node = NULL,
		    sale_expires_block = NULL, sale_commitment_op_tx_id = NULL, sale_commitment_buy_tx_hash = NULL
		WHERE id = ${nftId}
	`;
	// Queue the delta BEFORE counter updates. See insertNft for rationale —
	// any counter failure between here and the state-root flush would leave
	// the committed nfts row without a corresponding delta.
	const newRow: NftStateRow = {
		id: nftId,
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
	await adjustOwnerNftCount(ctx.oldOwner, ctx.nftType, -1, txn);
	await adjustOwnerNftCount(newOwner, ctx.nftType, 1, txn);
	if (ctx.wasListed) {
		await adjustCollectionListed(ctx.collectionId, -1, txn);
	}
}

export async function updateNftStatus(nftId: string, status: NftStatus, txn: Queryable = sql) {
	await txn`UPDATE nfts SET status = ${status} WHERE id = ${nftId}`;
}

export async function hardDeleteNft(
	nftId: string,
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
	const oldRow = await readStateRow(nftId, txn);
	if (!oldRow) throw new Error(`hardDeleteNft: nft ${nftId} not found`);
	await txn`
		INSERT INTO burned_nfts (id, collection_id, burned_by, tx_id, operation_id, created_at)
		VALUES (${nftId}, ${ctx.collectionId}, ${burnedBy}, ${txId}, ${operationId}, ${ctx.createdAt})
		ON CONFLICT (id) DO NOTHING
	`;
	await txn`DELETE FROM nfts WHERE id = ${nftId}`;
	// Queue the delta BEFORE counter updates. See insertNft for rationale.
	queueStateRootDelta(getStateRootBuffer(txn), {
		type: "delete",
		oldRow,
		blockNum: ctx.blockNum,
	});
	await adjustOwnerNftCount(ctx.owner, ctx.nftType, -1, txn);
	await recordCollectionBurn(ctx.collectionId, ctx.nftType, txn);
}

export async function updateNftListing(
	nftId: string,
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
			UPDATE nfts
			SET status = ${NFT_STATUS_ACTIVE},
			    listing_id = NULL, listing_tx_id = NULL,
			    listing_price = NULL, listing_currency = NULL, listing_expires_at = NULL, listing_marketplace = NULL
			WHERE id = ${nftId}
		`;
		if (ctx.wasListed) {
			await adjustCollectionListed(ctx.collectionId, -1, txn);
		}
	} else {
		const expiresIso = expiresAt ? new Date(expiresAt).toISOString() : null;
		await txn`
			UPDATE nfts
			SET status = ${NFT_STATUS_LISTED},
			    listing_id = ${listingId}, listing_tx_id = ${listingTxId},
			    listing_price = ${price}, listing_currency = ${currency},
			    listing_expires_at = ${expiresIso}, listing_marketplace = ${marketplace}
			WHERE id = ${nftId}
		`;
		if (!ctx.wasListed) {
			await adjustCollectionListed(ctx.collectionId, 1, txn);
		}
	}
}

/**
 * Returns every NFT whose `sale_expires_block < currentBlock` back to
 * `status='listed'`, clearing the five sale_* snapshot columns. Called by
 * the sync engine before routing any op at `currentBlock`, so every handler
 * observes a post-sweep world and can never settle a stale lock.
 *
 * `collection_stats.listed` is intentionally NOT touched: per protocol
 * §10.5 the counter already includes both `listed` and `pending_sale`
 * rows, so the listed↔pending_sale transition is counter-invariant.
 *
 * Runs under the batch transaction — rollback of the batch rolls back the
 * sweep. The partial index `idx_nfts_sale_expires` keeps this at ~0 cost
 * when no rows are due.
 */
export async function sweepExpiredBuyCommitments(currentBlock: number, txn: Queryable): Promise<number> {
	const result = await txn`
		UPDATE nfts
		SET status = ${NFT_STATUS_LISTED},
		    sale_buyer = NULL, sale_settlement_node = NULL,
		    sale_expires_block = NULL, sale_commitment_op_tx_id = NULL, sale_commitment_buy_tx_hash = NULL
		WHERE status = ${NFT_STATUS_PENDING_SALE}
		  AND sale_expires_block < ${currentBlock}
	`;
	return result.count;
}

export async function incrementDistributedBy(seedId: string, quantity: number, txn: Queryable = sql) {
	await txn`UPDATE nfts SET distributed = distributed + ${quantity} WHERE id = ${seedId}`;
}

export async function updateNftDataRef(
	nftId: string,
	dataHash: string,
	dataOperationId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE nfts
		SET data_hash = ${dataHash},
			data_operation_id = ${dataOperationId}
		WHERE id = ${nftId}
	`;
}

export async function cleanupInvalidMarketplaceListings(
	txn: Queryable = sql,
): Promise<MarketplaceListingCleanupResult> {
	const cleared = await txn`
		UPDATE nfts
		SET status = ${NFT_STATUS_ACTIVE},
		    listing_id = NULL, listing_tx_id = NULL,
		    listing_price = NULL, listing_currency = NULL,
		    listing_expires_at = NULL, listing_marketplace = NULL
		WHERE status = ${NFT_STATUS_LISTED}
			AND (
				nft_type <> ${NFT_KIND_INSTANCE}
				OR (listing_expires_at IS NOT NULL AND listing_expires_at <= NOW())
			)
	`;

	const reconciled = await txn`
		WITH active_listed AS (
			SELECT
				cs.collection_id,
				COUNT(n.id)::int AS listed
			FROM collection_stats cs
			LEFT JOIN nfts n ON n.collection_id = cs.collection_id
				AND n.nft_type = ${NFT_KIND_INSTANCE}
				AND n.status = ${NFT_STATUS_LISTED}
				AND (n.listing_expires_at IS NULL OR n.listing_expires_at > NOW())
			GROUP BY cs.collection_id
		)
		UPDATE collection_stats cs
		SET listed = active_listed.listed
		FROM active_listed
		WHERE cs.collection_id = active_listed.collection_id
			AND cs.listed <> active_listed.listed
	`;

	return {
		clearedListings: cleared.count,
		reconciledCollections: reconciled.count,
	};
}
