import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner, NFT_STATUS_BURNED, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";

export async function handleTransfer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const to = requireUsername(op.data.to, "to");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent and cannot be transferred: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	await updateNftOwner(nftId, to, txn);
	await deleteNftAllowance(nftId, txn);
}
