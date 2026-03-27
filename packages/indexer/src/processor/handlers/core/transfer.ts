import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner, updateNftListing } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertTransferable } from "@/utils/status-checks.ts";

export async function handleTransfer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const to = requireUsername(op.data.to, "to");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	const { hadExpiredListing } = assertTransferable(nft, nftId, op.timestamp);

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable`);
	}

	await updateNftOwner(nftId, to, txn);
	await deleteNftAllowance(nftId, txn);

	if (hadExpiredListing) {
		await updateNftListing(nftId, null, null, null, null, txn);
	}
}
