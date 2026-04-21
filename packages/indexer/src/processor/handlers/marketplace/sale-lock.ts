import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getNftForProcessingForUpdate,
	NFT_STATUS_LISTED,
	NFT_STATUS_PENDING_SALE,
} from "@/db/queries/nfts.ts";
import { assertActiveSettlementNode } from "@/db/queries/nodes.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertActionable, assertMarketplaceInstance, isListingExpired } from "@/utils/status-checks.ts";
import { SALE_LOCK_DURATION_BLOCKS } from "@/protocol/index.ts";

/**
 * Processes a `sale_lock` custom_json emitted by a settlement node's posting
 * key. Reserves a currently-listed NFT for the declared buyer by moving the
 * row from `status='listed'` to `status='pending_sale'` and snapshotting the
 * lock metadata (buyer, settlement node, expiry block, lock tx+op ids) onto
 * the NFT row.
 *
 * Consensus determinism: every validator sees the same `op.blockNum`, so
 * `sale_expires_block = op.blockNum + SALE_LOCK_DURATION_BLOCKS` is computed
 * identically across the network. The lazy sweep in `sync-engine.ts` returns
 * expired reservations to `status='listed'` before routing later ops.
 *
 * The subsequent `buy` custom_json (inside the buyer-initiated tx) must match
 * this lock's (nftId, listingId, listTxId, sale_settlement_node, sale_buyer)
 * tuple to settle — see handlers/marketplace/buy.ts.
 */
export async function handleSaleLock(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	await assertActiveSettlementNode(op.signer, op.blockNum, txn);

	const nftId = requireString(op.data.nftId, "nftId");
	const listingId = requireString(op.data.listingId, "listingId");
	const listTxId = requireString(op.data.listTxId, "listTxId");
	const buyer = requireUsername(op.data.buyer, "buyer");

	const nft = await getNftForProcessingForUpdate(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	assertActionable(nft, nftId);
	assertMarketplaceInstance(nft, nftId);
	if (nft.status !== NFT_STATUS_LISTED) {
		throw new Error(`NFT ${nftId} is not listed (status=${nft.status}) — cannot sale_lock`);
	}
	if (nft.listing_id !== listingId) {
		throw new Error(`listingId mismatch: expected '${nft.listing_id}', got '${listingId}'`);
	}
	if (nft.listing_tx_id !== listTxId) {
		throw new Error(`listTxId mismatch: expected '${nft.listing_tx_id}', got '${listTxId}'`);
	}
	if (isListingExpired(nft.listing_expires_at, op.timestamp)) {
		throw new Error(`Listing has expired for NFT: ${nftId}`);
	}
	if (nft.owner === buyer) {
		throw new Error(`Cannot sale_lock buyer equal to seller for NFT: ${nftId}`);
	}

	const saleExpiresBlock = op.blockNum + SALE_LOCK_DURATION_BLOCKS;
	await txn`
		UPDATE nfts
		SET status = ${NFT_STATUS_PENDING_SALE},
		    sale_buyer = ${buyer},
		    sale_settlement_node = ${op.signer},
		    sale_expires_block = ${saleExpiresBlock},
		    sale_lock_tx_id = ${op.txId},
		    sale_lock_operation_id = ${op.operationId}
		WHERE id = ${nftId}
	`;
	return [nftId];
}
