import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getAssetWithCollectionRulesForUpdate,
	updateAssetOwner,
	ASSET_STATUS_PENDING_SALE,
} from "@/db/queries/assets.ts";
import type { OwnerChangeCtx } from "@/db/queries/assets.ts";
import { deleteAssetAllowance, cleanupCollectionAllowancesIfEmpty } from "@/db/queries/allowances.ts";
import { insertSale } from "@/db/queries/marketplace-history.ts";
import { requireShapedString, requireUsername, verifyTransfers, requireStoredSupportedCurrency } from "@/utils/validation.ts";
import { validateTransferCount } from "@/utils/asset-rules.ts";
import { assertActionable, assertMarketplaceInstance, isListingExpired } from "@/utils/status-checks.ts";
import { ACTION_BUY, MAX_ROYALTY_PCT, isHiveTxId, isInstanceId, isListingId } from "@/protocol/index.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

/**
 * Settles a `buy` action against the on-chain reservation projected by the
 * preceding `buy_commitment` op. The Hive transaction carries the buyer-funded
 * transfers plus the trailing `buy` custom_json co-signed by the committed
 * settlement node; `handleBuy` refuses to close the sale unless:
 *
 *   asset.status = 'pending_sale'                           (a commitment landed)
 *   asset.sale_commitment_buy_tx_hash = op.txId             (this buy-tx is the
 *                                                          one the node reserved)
 *   asset.sale_buyer = buyer-from-transfers                 (same buyer)
 *   currentBlock <= asset.sale_expires_block                (commitment not yet
 *                                                          swept)
 *
 * The commitment-tx-hash match is the core guarantee: Hive's tx_id is a digest
 * of the entire transaction bytes, and the buyer's active signature fixes those
 * bytes at sign time. A node that attempted to broadcast a different buy-tx
 * than the one it committed to would have to mint a transaction whose tx_id
 * collided with the committed hash — computationally infeasible.
 */
export async function handleBuy(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const assetId = requireShapedString(op.data.assetId, "assetId", isInstanceId, "asset_<20 hex>_<instance>");
	const listingId = requireShapedString(op.data.listingId, "listingId", isListingId, "list_<32 hex>");
	const listTxId = requireShapedString(op.data.listTxId, "listTxId", isHiveTxId, "<40 lowercase hex>");

	const transfers = op.pairedTransfers ?? [];

	const asset = await getAssetWithCollectionRulesForUpdate(assetId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${assetId}`);
	assertActionable(asset, assetId);
	assertMarketplaceInstance(asset, assetId);

	if (asset.status !== ASSET_STATUS_PENDING_SALE) {
		throw protocolReject(`Asset ${assetId} is not reserved (status=${asset.status}) — buy rejected`);
	}
	const expectedBuyTxHash = asset.sale_commitment_buy_tx_hash;
	if (!expectedBuyTxHash || expectedBuyTxHash.toLowerCase() !== op.txId.toLowerCase()) {
		throw protocolReject(
			`Buy tx_id ${op.txId} does not match committed hash ${expectedBuyTxHash ?? "<none>"} for Asset ${assetId}`,
		);
	}
	// Defense-in-depth: under correct digest computation + Hive consensus, the
	// tx_id match above already pins op.signer to the committed node (the buy
	// custom_json's required_auths is part of the digested bytes). This explicit
	// check turns a silent invariant into a loud one — any future regression
	// in the multisig digest path would surface here instead of allowing an
	// unrelated active node to settle the commitment.
	if (asset.sale_settlement_node !== op.signer) {
		throw protocolReject(
			`Settlement node mismatch for Asset ${assetId}: committed by '${asset.sale_settlement_node ?? "<none>"}', `
			+ `buy signed by '${op.signer}'`,
		);
	}
	if (asset.sale_expires_block !== null && op.blockNum > asset.sale_expires_block) {
		throw protocolReject(
			`Commitment for Asset ${assetId} expired at block ${asset.sale_expires_block} (current ${op.blockNum})`,
		);
	}
	if (asset.listing_id !== listingId) {
		throw protocolReject(`listingId mismatch: expected '${asset.listing_id}', got '${listingId}'`);
	}
	if (asset.listing_tx_id !== listTxId) {
		throw protocolReject(`listTxId mismatch: expected '${asset.listing_tx_id}', got '${listTxId}'`);
	}
	if (isListingExpired(asset.listing_expires_at, op.timestamp)) {
		throw protocolReject(`Listing has expired for Asset: ${assetId}`);
	}
	if (!asset.transferable) {
		throw protocolReject(`Collection ${asset.collection_id} is not transferable — buy blocked`);
	}

	const totalPrice = Number(asset.listing_price);
	if (Number.isNaN(totalPrice) || totalPrice <= 0 || !asset.listing_currency) {
		throw protocolReject("Asset has no valid listing price");
	}
	const currency = requireStoredSupportedCurrency(asset.listing_currency, "listing_currency");

	const royaltyPct = Number(asset.royalty_pct ?? 0);
	if (royaltyPct < 0 || royaltyPct > MAX_ROYALTY_PCT) {
		throw new Error(`Corrupted royalty_pct for collection ${asset.collection_id}: ${royaltyPct}`);
	}
	const royaltyRecipient = asset.royalty_recipient ?? null;

	const { split, buyerFromTransfer } = verifyTransfers({
		transfers,
		seller: asset.owner,
		totalPrice,
		currency,
		royaltyPct,
		royaltyRecipient,
		feeAccount: op.signer,
		assetId,
		consumedIndices: op.transferPool?.consumed,
	});
	const buyer = requireUsername(buyerFromTransfer, "buyer");
	if (asset.owner === buyer) throw protocolReject(`Cannot buy own Asset: ${assetId}`);
	if (asset.sale_buyer !== buyer) {
		throw protocolReject(
			`Buyer ${buyer} does not match committed buyer ${asset.sale_buyer} for Asset ${assetId}`,
		);
	}
	validateTransferCount(transfers, split, op.transferPool?.consumed);

	await insertSale({
		assetId,
		collectionId: asset.collection_id,
		listingId,
		seller: asset.owner,
		buyer,
		grossAmount: totalPrice,
		currency,
		royaltyAmount: split.royaltyAmount,
		protocolFee: split.feeAmount,
		sellerNet: split.sellerAmount,
		blockNum: op.blockNum,
		txId: op.txId,
		createdAt: op.timestamp,
	}, txn);

	const previousOwner = asset.owner;
	const ctx: OwnerChangeCtx = {
		oldOwner: previousOwner,
		assetType: asset.asset_type,
		collectionId: asset.collection_id,
		ownerAction: ACTION_BUY,
		ownerBlockNum: op.blockNum,
		wasListed: true,
	};
	await updateAssetOwner(assetId, buyer, op.operationId, ctx, txn);
	await deleteAssetAllowance(assetId, txn);
	await cleanupCollectionAllowancesIfEmpty(previousOwner, asset.collection_id, txn);

	return [assetId];
}
