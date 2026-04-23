import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getNftWithCollectionRulesForUpdate,
	updateNftOwner,
	NFT_STATUS_PENDING_SALE,
} from "@/db/queries/nfts.ts";
import type { OwnerChangeCtx } from "@/db/queries/nfts.ts";
import { deleteNftAllowance, cleanupCollectionAllowancesIfEmpty } from "@/db/queries/allowances.ts";
import { insertSale } from "@/db/queries/marketplace-history.ts";
import { requireString, requireUsername, verifyTransfers, requireSupportedCurrency } from "@/utils/validation.ts";
import { validateTransferCount } from "@/utils/nft-rules.ts";
import { assertActionable, assertMarketplaceInstance, isListingExpired } from "@/utils/status-checks.ts";
import { ACTION_BUY } from "@/protocol/index.ts";

/**
 * Settles a `buy` action against the on-chain reservation projected by the
 * preceding `buy_commitment` op. The Hive transaction carries the buyer-funded
 * transfers plus the trailing `buy` custom_json co-signed by the committed
 * settlement node; `handleBuy` refuses to close the sale unless:
 *
 *   nft.status = 'pending_sale'                           (a commitment landed)
 *   nft.sale_commitment_buy_tx_hash = op.txId             (this buy-tx is the
 *                                                          one the node reserved)
 *   nft.sale_buyer = buyer-from-transfers                 (same buyer)
 *   currentBlock <= nft.sale_expires_block                (commitment not yet
 *                                                          swept)
 *
 * The commitment-tx-hash match is the core guarantee: Hive's tx_id is a digest
 * of the entire transaction bytes, and the buyer's active signature fixes those
 * bytes at sign time. A node that attempted to broadcast a different buy-tx
 * than the one it committed to would have to mint a transaction whose tx_id
 * collided with the committed hash — computationally infeasible.
 */
export async function handleBuy(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const nftId = requireString(op.data.nftId, "nftId");
	const listingId = requireString(op.data.listingId, "listingId");
	const listTxId = requireString(op.data.listTxId, "listTxId");

	const transfers = op.pairedTransfers ?? [];

	const nft = await getNftWithCollectionRulesForUpdate(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	assertActionable(nft, nftId);
	assertMarketplaceInstance(nft, nftId);

	if (nft.status !== NFT_STATUS_PENDING_SALE) {
		throw new Error(`NFT ${nftId} is not reserved (status=${nft.status}) — buy rejected`);
	}
	const expectedBuyTxHash = nft.sale_commitment_buy_tx_hash;
	if (!expectedBuyTxHash || expectedBuyTxHash.toLowerCase() !== op.txId.toLowerCase()) {
		throw new Error(
			`Buy tx_id ${op.txId} does not match committed hash ${expectedBuyTxHash ?? "<none>"} for NFT ${nftId}`,
		);
	}
	// Defense-in-depth: under correct digest computation + Hive consensus, the
	// tx_id match above already pins op.signer to the committed node (the buy
	// custom_json's required_auths is part of the digested bytes). This explicit
	// check turns a silent invariant into a loud one — any future regression
	// in the multisig digest path would surface here instead of allowing an
	// unrelated active node to settle the commitment.
	if (nft.sale_settlement_node !== op.signer) {
		throw new Error(
			`Settlement node mismatch for NFT ${nftId}: committed by '${nft.sale_settlement_node ?? "<none>"}', `
			+ `buy signed by '${op.signer}'`,
		);
	}
	if (nft.sale_expires_block !== null && op.blockNum > nft.sale_expires_block) {
		throw new Error(
			`Commitment for NFT ${nftId} expired at block ${nft.sale_expires_block} (current ${op.blockNum})`,
		);
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
	if (!nft.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable — buy blocked`);
	}

	const totalPrice = Number(nft.listing_price);
	if (Number.isNaN(totalPrice) || totalPrice <= 0 || !nft.listing_currency) {
		throw new Error("NFT has no valid listing price");
	}
	const currency = requireSupportedCurrency(nft.listing_currency, "listing_currency");

	const royaltyPct = Number(nft.royalty_pct ?? 0);
	if (royaltyPct < 0 || royaltyPct > 50) {
		throw new Error(`Corrupted royalty_pct for collection ${nft.collection_id}: ${royaltyPct}`);
	}
	const royaltyRecipient = nft.royalty_recipient ?? null;

	const { split, buyerFromTransfer } = verifyTransfers({
		transfers,
		seller: nft.owner,
		totalPrice,
		currency,
		royaltyPct,
		royaltyRecipient,
		feeAccount: op.signer,
		nftId,
		consumedIndices: op.transferPool?.consumed,
	});
	const buyer = requireUsername(buyerFromTransfer, "buyer");
	if (nft.owner === buyer) throw new Error(`Cannot buy own NFT: ${nftId}`);
	if (nft.sale_buyer !== buyer) {
		throw new Error(
			`Buyer ${buyer} does not match committed buyer ${nft.sale_buyer} for NFT ${nftId}`,
		);
	}
	validateTransferCount(transfers, split, op.transferPool?.consumed);

	await insertSale({
		nftId,
		collectionId: nft.collection_id,
		listingId,
		seller: nft.owner,
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

	const previousOwner = nft.owner;
	const ctx: OwnerChangeCtx = {
		oldOwner: previousOwner,
		nftType: nft.nft_type,
		collectionId: nft.collection_id,
		ownerAction: ACTION_BUY,
		ownerBlockNum: op.blockNum,
		wasListed: true,
	};
	await updateNftOwner(nftId, buyer, op.operationId, ctx, txn);
	await deleteNftAllowance(nftId, txn);
	await cleanupCollectionAllowancesIfEmpty(previousOwner, nft.collection_id, txn);

	return [nftId];
}
