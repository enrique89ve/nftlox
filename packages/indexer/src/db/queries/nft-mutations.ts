import { sql, type Queryable } from "@/db/client.ts";
import type { InsertNftParams, OwnerChangeCtx, BurnCtx, ListingCtx, NftStatus } from "./nft-types.ts";
import { NFT_STATUS_ACTIVE, NFT_STATUS_LISTED } from "./nft-types.ts";
import { adjustOwnerNftCount, recordCollectionMint, adjustCollectionListed, recordCollectionBurn } from "./nft-counters.ts";

export async function insertNft(params: InsertNftParams, txn: Queryable = sql): Promise<boolean> {
	const result = await txn`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner,
			origin_dna, instance_dna,
			name, image_url,
			max_replicas, distributed,
			seed_id, instance_number, original_id,
			immutable_data,
			data_operation_id, data_hash,
			schema_version, owner_tx_id,
			operation_id,
			block_num, tx_id, created_at
		) VALUES (
			${params.id}, ${params.collectionId}, ${params.nftType},
			${params.status ?? NFT_STATUS_ACTIVE}, ${params.edition}, ${params.owner},
			${params.originDna}, ${params.instanceDna},
			${params.name}, ${params.imageUrl},
			${params.maxReplicas}, ${params.distributed ?? 0},
			${params.seedId}, ${params.instanceNumber}, ${params.originalId},
			${params.immutableData ? JSON.stringify(params.immutableData) : null},
			${params.dataOperationId}, ${params.dataHash},
			${params.schemaVersion ?? null},
			${params.txId},
			${params.operationId ?? null},
			${params.blockNum}, ${params.txId}, ${params.createdAt}
		)
		ON CONFLICT (id) DO NOTHING
	`;
	if (result.count > 0) {
		await adjustOwnerNftCount(params.owner, params.nftType, 1, txn);
		await recordCollectionMint(params.collectionId, params.nftType, txn);
	}
	return result.count > 0;
}

export async function updateNftOwner(
	nftId: string,
	newOwner: string,
	ownerTxId: string,
	ctx: OwnerChangeCtx,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE nfts
		SET owner = ${newOwner}, status = ${NFT_STATUS_ACTIVE},
		    owner_tx_id = ${ownerTxId},
		    listing_id = NULL, listing_tx_id = NULL,
		    listing_price = NULL, listing_currency = NULL, listing_expires_at = NULL, listing_marketplace = NULL
		WHERE id = ${nftId}
	`;
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
	ctx: BurnCtx,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO burned_nfts (id, collection_id, burned_by, tx_id)
		VALUES (${nftId}, ${ctx.collectionId}, ${burnedBy}, ${txId})
		ON CONFLICT (id) DO NOTHING
	`;
	await txn`DELETE FROM nfts WHERE id = ${nftId}`;
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
