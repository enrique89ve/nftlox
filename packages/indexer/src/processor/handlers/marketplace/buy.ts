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
import { assertActionable, assertMarketplaceInstance } from "@/utils/status-checks.ts";
import { ACTION_BUY } from "@/protocol/index.ts";

/**
 * Processes a `buy` action that settles a pending sale_lock.
 *
 * The custom_json is inside the buyer-initiated tx2 signed with the buyer's
 * active key. `op.signer` is the settlement node's posting key (the lock
 * owner) — the active-key paired transfers prove buyer intent.
 *
 * Preconditions enforced here (C3 hardfork):
 *   1. NFT.status === 'pending_sale' — only locked rows are buyable.
 *   2. NFT.sale_settlement_node === op.signer — the node that issued the
 *      lock is the only node allowed to broadcast the buy.
 *   3. op.blockNum <= NFT.sale_expires_block — the lock has not expired.
 *   4. NFT.listing_id === payload.listingId AND listing_tx_id === listTxId.
 *   5. verifyTransfers-extracted buyer === NFT.sale_buyer (no impersonation).
 *
 * On success `updateNftOwner` atomically clears sale_* and listing_* columns
 * while flipping status to 'active' — there is no residual pending-sale
 * state after a buy commits.
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
		throw new Error(`NFT ${nftId} is not pending_sale (status=${nft.status}) — buy rejected`);
	}
	if (nft.sale_settlement_node !== op.signer) {
		throw new Error(
			`sale_settlement_node mismatch: expected '${nft.sale_settlement_node}', got '${op.signer}'`,
		);
	}
	if (nft.sale_expires_block === null || op.blockNum > nft.sale_expires_block) {
		throw new Error(
			`sale_lock expired: current block ${op.blockNum} exceeds sale_expires_block ${nft.sale_expires_block}`,
		);
	}
	if (nft.listing_id !== listingId) {
		throw new Error(`listingId mismatch: expected '${nft.listing_id}', got '${listingId}'`);
	}
	if (nft.listing_tx_id !== listTxId) {
		throw new Error(`listTxId mismatch: expected '${nft.listing_tx_id}', got '${listTxId}'`);
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
			`sale_buyer mismatch: sale_lock reserved '${nft.sale_buyer}', transfers came from '${buyer}'`,
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
		// pending_sale still counts toward collection_stats.listed (plan §10.5),
		// so a completed buy must decrement listed exactly once.
		wasListed: true,
	};
	await updateNftOwner(nftId, buyer, op.operationId, ctx, txn);
	await deleteNftAllowance(nftId, txn);
	await cleanupCollectionAllowancesIfEmpty(previousOwner, nft.collection_id, txn);

	return [nftId];
}
