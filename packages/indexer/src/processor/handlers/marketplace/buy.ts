import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftWithCollectionRules, getNftWithCollectionRulesForUpdate, updateNftOwner, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import type { OwnerChangeCtx } from "@/db/queries/nfts.ts";
import { deleteNftAllowance, cleanupCollectionAllowancesIfEmpty } from "@/db/queries/allowances.ts";
import { insertSale } from "@/db/queries/marketplace-history.ts";
import { requireString, requireUsername, verifyTransfers, requireSupportedCurrency } from "@/utils/validation.ts";
import { validateTransferCount } from "@/utils/nft-rules.ts";
import { assertActionable, assertMarketplaceInstance, isListingExpired } from "@/utils/status-checks.ts";
import { consumeMultisigLockIfMatches } from "@/utils/multisig-locks.ts";
import { createLogger } from "@/utils/logger.ts";
import { config } from "@/config.ts";
import { ACTION_BUY, UNLIST_DELAY_BLOCKS } from "@/protocol/index.ts";

const log = createLogger("handler:buy");

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

	const transfers = op.pairedTransfers ?? [];

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
	// Reject buys that land past the unlist-delay window. An unlist at block X
	// keeps the NFT comprable through block X + UNLIST_DELAY_BLOCKS inclusive;
	// beyond that the sync engine will materialize the unlist at block close
	// anyway, so a late buy here would either race the materialization or
	// settle against a logically-unlisted NFT.
	if (nft.pending_unlist_block !== null) {
		const deadline = nft.pending_unlist_block + UNLIST_DELAY_BLOCKS;
		if (op.blockNum > deadline) {
			throw new Error(
				`unlist_effective: NFT ${nftId} was unlisted at block ${nft.pending_unlist_block}, ` +
					`deadline ${deadline}, buy arrived at block ${op.blockNum}`,
			);
		}
	}

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

	// Canonical buyer identity: verifyTransfers finds the unique seller-leg
	// transfer (to=seller, amount=sellerAmount, currency, memo=`BUY:nftId`)
	// and returns its `from`. This replaces the previous positional read and
	// same-memo pre-filter — an extra (different amount/to) transfer sharing
	// the BUY memo no longer triggers a false-ambiguous rejection.
	// consumedIndices prevents multi-buy in the same tx from sharing transfers.
	const { split, buyerFromTransfer } = verifyTransfers({
		transfers,
		seller: nft.owner,
		totalPrice,
		currency,
		royaltyPct,
		royaltyRecipient,
		feeAccount: config.hiveAccount,
		nftId,
		consumedIndices: op.transferPool?.consumed,
	});
	const buyer = requireUsername(buyerFromTransfer, "buyer");
	if (nft.owner === buyer) throw new Error(`Cannot buy own NFT: ${nftId}`);

	validateTransferCount(transfers, split, op.transferPool?.consumed);

	// Consume the multisig lock iff the buy matches (nftId + buyer + listing_id
	// + list_tx_id). A non-matching active lock means another node co-signed a
	// different buyer — accept THIS buy (another node's signed tx won the
	// race) but leave the foreign lock intact so it still protects its own
	// in-flight tx. A missing lock is normal on multi-node setups where the
	// signing node's lock lives in a different DB.
	const lockOutcome = await consumeMultisigLockIfMatches({
		nftId,
		buyer,
		listingId,
		listTxId,
		blockTimestamp: op.timestamp,
		txn,
	});
	if (lockOutcome.outcome === "foreign_lock") {
		log.warn("buy accepted despite foreign multisig lock — another node co-signed a different buyer", {
			nftId,
			block: op.blockNum,
			foreignBuyer: lockOutcome.lock.buyer,
			foreignListing: lockOutcome.lock.listing_id,
			acceptedBuyer: buyer,
			acceptedListing: listingId,
		});
	}

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
