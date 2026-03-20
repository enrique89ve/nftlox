import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftCustomData, NFT_STATUS_BURNED } from "@/db/queries/nfts.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString, optionalStringArray } from "@/utils/validation.ts";

export async function handleSetData(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const instanceDna = requireString(op.data.instanceDna, "instanceDna");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);
	if (nft.instance_dna !== instanceDna) throw new Error(`Instance DNA mismatch for ${nftId}`);

	await updateNftCustomData(nftId, op.data.data ?? null, optionalStringArray(op.data.tags), txn);
	await insertHistoryEvent({
		nftId, collectionId: nft.collection_id, eventType: "set_data",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: null,
		priceAmount: null, priceCurrency: null, payload: op.data,
	}, txn);
}
