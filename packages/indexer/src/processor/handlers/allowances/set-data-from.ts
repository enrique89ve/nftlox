import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOperatorData, NFT_STATUS_BURNED } from "@/db/queries/nfts.ts";
import { hasDataOperatorApproval } from "@/db/queries/allowances.ts";
import { requireString, optionalStringArray } from "@/utils/validation.ts";

export async function handleSetDataFrom(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const instanceDna = requireString(op.data.instanceDna, "instanceDna");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);

	if (nft.instance_dna !== instanceDna) {
		throw new Error(`Instance DNA mismatch for ${nftId}`);
	}

	const isOperator = await hasDataOperatorApproval(nft.collection_id, op.signer, txn);
	if (!isOperator) {
		throw new Error(`Signer ${op.signer} is not an approved data operator for collection ${nft.collection_id}`);
	}

	await updateNftOperatorData(nftId, op.data.data ?? null, optionalStringArray(op.data.tags), txn);
}
