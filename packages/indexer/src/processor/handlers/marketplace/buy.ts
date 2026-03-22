import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftWithCollectionRules, updateNftOwner, NFT_STATUS_LISTED, NFT_STATUS_BURNED, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, verifyTransfers } from "@/utils/validation.ts";
import { config } from "@/config.ts";

/**
 * Processes a `buy` action AFTER it appears on-chain (post-multisig broadcast).
 *
 * The custom_json's required_auths is [nodeAccount], so op.signer is the NODE,
 * not the buyer. The buyer is extracted from the first paired transfer's `from`.
 */
export async function handleBuy(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");

	const buyer = op.pairedTransfers?.[0]?.from;
	if (!buyer) throw new Error("No payment transfers found for buy action");

	const nft = await getNftWithCollectionRules(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent: ${nftId}`);
	if (nft.status !== NFT_STATUS_LISTED) throw new Error(`NFT not listed: ${nftId}`);
	if (nft.owner === buyer) throw new Error(`Cannot buy own NFT: ${nftId}`);

	const totalPrice = Number(nft.listing_price);
	if (!totalPrice || !nft.listing_currency) {
		throw new Error("NFT has no valid listing price");
	}

	const royaltyPct = Number(nft.royalty_pct ?? 0);
	const royaltyRecipient = nft.royalty_recipient ?? null;
	const feeAccount = nft.listing_marketplace || config.hiveAccount;

	// Verify payment split from paired transfers
	verifyTransfers({
		transfers: op.pairedTransfers ?? [],
		buyer,
		seller: nft.owner,
		totalPrice,
		currency: nft.listing_currency,
		royaltyPct,
		royaltyRecipient,
		feeAccount,
	});

	await updateNftOwner(nftId, buyer, txn);
	await deleteNftAllowance(nftId, txn);
}
