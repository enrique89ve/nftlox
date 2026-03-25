import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner, NFT_STATUS_BURNED, NFT_STATUS_LENT, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";

const isListingExpired = (expiresAt: string | null): boolean => {
	if (!expiresAt) return false;
	return Date.now() > new Date(expiresAt).getTime();
};

export async function handleTransfer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const to = requireUsername(op.data.to, "to");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent and cannot be transferred: ${nftId}`);
	if (nft.status === NFT_STATUS_LISTED && !isListingExpired(nft.listing_expires_at)) {
		throw new Error(`NFT is listed for sale and must be unlisted first: ${nftId}`);
	}
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable`);
	}

	await updateNftOwner(nftId, to, txn);
	await deleteNftAllowance(nftId, txn);
}
