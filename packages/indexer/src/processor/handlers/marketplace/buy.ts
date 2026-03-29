import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftWithCollectionRules, updateNftOwner, NFT_STATUS_LISTED, NFT_STATUS_BURNED, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireUsername, verifyTransfers } from "@/utils/validation.ts";
import { isListingExpired } from "@/utils/status-checks.ts";
import { config } from "@/config.ts";

/**
 * Processes a `buy` action AFTER it appears on-chain (post-multisig broadcast).
 *
 * The custom_json's required_auths is [nodeAccount], so op.signer is the NODE,
 * not the buyer. The buyer is extracted from the first paired transfer's `from`.
 *
 * Security: the router enforces active key auth; this handler enforces the signer
 * is the configured node account — matching multisig-service.ts validation.
 *
 * v0.3.0: Now validates listingId + listTxId to prevent stale listing replays.
 */
export async function handleBuy(op: ParsedOperation, txn: Queryable): Promise<void> {
	if (op.signer !== config.hiveAccount) {
		throw new Error(
			`Buy must be signed by node account '${config.hiveAccount}', got '${op.signer}'`,
		);
	}

	const nftId = requireString(op.data.nftId, "nftId");
	const listingId = requireString(op.data.listingId, "listingId");
	const listTxId = requireString(op.data.listTxId, "listTxId");

	const rawBuyer = op.pairedTransfers?.[0]?.from;
	if (!rawBuyer) throw new Error("No payment transfers found for buy action");
	const buyer = requireUsername(rawBuyer, "buyer");

	const nft = await getNftWithCollectionRules(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent: ${nftId}`);
	if (nft.status !== NFT_STATUS_LISTED) throw new Error(`NFT not listed: ${nftId}`);
	if (isListingExpired(nft.listing_expires_at, op.timestamp)) {
		throw new Error(`Listing has expired for NFT: ${nftId}`);
	}
	if (nft.owner === buyer) throw new Error(`Cannot buy own NFT: ${nftId}`);

	// Validate listingId matches the active listing
	if (nft.listing_id !== listingId) {
		throw new Error(`listingId mismatch: expected '${nft.listing_id}', got '${listingId}'`);
	}

	// Validate listTxId matches the listing transaction
	if (nft.listing_tx_id !== listTxId) {
		throw new Error(`listTxId mismatch: expected '${nft.listing_tx_id}', got '${listTxId}'`);
	}

	const totalPrice = Number(nft.listing_price);
	if (Number.isNaN(totalPrice) || totalPrice <= 0 || !nft.listing_currency) {
		throw new Error("NFT has no valid listing price");
	}

	const royaltyPct = Number(nft.royalty_pct ?? 0);
	const royaltyRecipient = nft.royalty_recipient ?? null;

	// Protocol fee always goes to the co-signing node
	const transfers = op.pairedTransfers ?? [];
	const split = verifyTransfers({
		transfers,
		buyer,
		seller: nft.owner,
		totalPrice,
		currency: nft.listing_currency,
		royaltyPct,
		royaltyRecipient,
		feeAccount: config.hiveAccount,
	});

	// Validate exact transfer count — reject extra transfers
	let expectedCount = 0;
	if (split.sellerAmount > 0) expectedCount++;
	if (split.royaltyAmount > 0 && split.royaltyRecipient) expectedCount++;
	if (split.feeAmount > 0) expectedCount++;

	if (transfers.length !== expectedCount) {
		throw new Error(
			`Expected exactly ${expectedCount} transfers, got ${transfers.length}`,
		);
	}

	await updateNftOwner(nftId, buyer, txn);
	await deleteNftAllowance(nftId, txn);
}
