import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwnerData, NFT_STATUS_BURNED } from "@/db/queries/nfts.ts";
import { requireString, requireObject } from "@/utils/validation.ts";
import { computeDataHashSync } from "nftlox-sdk";

export async function handleSetOwnerData(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const instanceDna = requireString(op.data.instanceDna, "instanceDna");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);
	if (nft.instance_dna !== instanceDna) throw new Error(`Instance DNA mismatch for ${nftId}`);

	const ownerData = requireObject(op.data.data, "data") as Record<string, unknown>;
	const dataHash = computeDataHashSync(ownerData);

	await updateNftOwnerData(nftId, ownerData, dataHash, op.txId, op.blockNum, txn);
}
