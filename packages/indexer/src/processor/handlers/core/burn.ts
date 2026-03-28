import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftBurned } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString } from "@/utils/validation.ts";
import { assertNotBurned, assertNotLent, assertNotListed } from "@/utils/status-checks.ts";

export async function handleBurn(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	assertNotBurned(nft, nftId);
	assertNotLent(nft, nftId);
	assertNotListed(nft, nftId);

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const collection = await getCollectionRules(nft.collection_id, txn);
	if (collection && !collection.burnable) {
		throw new Error(`Collection ${nft.collection_id} does not allow burning`);
	}

	await updateNftBurned(nftId, op.signer, op.blockNum, txn);
	await deleteNftAllowance(nftId, txn);
}
