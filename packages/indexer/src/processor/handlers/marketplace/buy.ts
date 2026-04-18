import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftWithCollectionRules, getNftWithCollectionRulesForUpdate, updateNftOwner, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import type { OwnerChangeCtx } from "@/db/queries/nfts.ts";
import { deleteNftAllowance, cleanupCollectionAllowancesIfEmpty } from "@/db/queries/allowances.ts";
import { insertSale } from "@/db/queries/marketplace-history.ts";
import { requireString, requireUsername, verifyTransfers, requireSupportedCurrency } from "@/utils/validation.ts";
import { validateTransferCount } from "@/utils/nft-rules.ts";
import { assertActionable, assertMarketplaceInstance, isListingExpired } from "@/utils/status-checks.ts";
import { config } from "@/config.ts";
import { ACTION_BUY } from "@/protocol/index.ts";

/**
 * Processes a `buy` action AFTER it appears on-chain (post-multisig broadcast).
 *
 * The custom_json's required_auths is [nodeAccount], so op.signer is the NODE,
 * not the buyer. The buyer is extracted from the first paired transfer's `from`.
 *
 * Security: the router enforces active key auth; this handler enforces the signer
 * is the configured node account — matching multisig-service.ts validation.
 *
 * Validates listingId + listTxId to prevent stale listing replays.
 */
export async function handleBuy(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	if (op.signer !== config.hiveAccount) {
		throw new Error(
			`Buy must be signed by node account '${config.hiveAccount}', got '${op.signer}'`,
		);
	}

	const nftId = requireString(op.data.nftId, "nftId");
	const listingId = requireString(op.data.listingId, "listingId");
	const listTxId = requireString(op.data.listTxId, "listTxId");
	const txId = requireString(op.data.txId, "txId");

	const rawBuyer = op.pairedTransfers?.[0]?.from;
	if (!rawBuyer) throw new Error("No payment transfers found for buy action");
	const buyer = requireUsername(rawBuyer, "buyer");

	const nft = await getNftWithCollectionRulesForUpdate(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	// assertActionable rejects burned + lent; status check below rejects anything not listed.
	// Combined: only NFTs with status=listed pass through.
	assertActionable(nft, nftId);
	assertMarketplaceInstance(nft, nftId);
	if (nft.status !== NFT_STATUS_LISTED) throw new Error(`NFT not listed: ${nftId}`);
	if (isListingExpired(nft.listing_expires_at, op.timestamp)) {
		throw new Error(`Listing has expired for NFT: ${nftId}`);
	}
	if (nft.owner === buyer) throw new Error(`Cannot buy own NFT: ${nftId}`);

	if (!nft.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable — buy blocked`);
	}

	// Validate listingId matches the active listing
	if (nft.listing_id !== listingId) {
		throw new Error(`listingId mismatch: expected '${nft.listing_id}', got '${listingId}'`);
	}

	// Validate listTxId matches the listing transaction
	if (nft.listing_tx_id !== listTxId) {
		throw new Error(`listTxId mismatch: expected '${nft.listing_tx_id}', got '${listTxId}'`);
	}

	// Validate txId matches the NFT's creation transaction
	if (nft.created_tx_id !== txId) {
		throw new Error(`txId mismatch: expected '${nft.created_tx_id}', got '${txId}'`);
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

	// Protocol fee always goes to the co-signing node.
	// consumedIndices prevents multi-buy in the same tx from sharing transfers.
	const transfers = op.pairedTransfers ?? [];
	const split = verifyTransfers({
		transfers,
		buyer,
		seller: nft.owner,
		totalPrice,
		currency,
		royaltyPct,
		royaltyRecipient,
		feeAccount: config.hiveAccount,
		nftId,
		consumedIndices: op.transferPool?.consumed,
	});

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
		wasListed: true, // buy always transitions from status='listed'
	};
	await updateNftOwner(nftId, buyer, op.operationId, ctx, txn);
	await deleteNftAllowance(nftId, txn);
	await cleanupCollectionAllowancesIfEmpty(previousOwner, nft.collection_id, txn);

	return [nftId];
}
