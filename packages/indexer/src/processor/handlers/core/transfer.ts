import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertTransferable, assertSeedNotDistributed } from "@/utils/status-checks.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("handler:transfer");

export async function handleTransfer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const to = requireUsername(op.data.to, "to");
	if (to === op.signer) throw new Error(`Cannot transfer NFT to yourself: ${nftId}`);

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	const { hadExpiredListing } = assertTransferable(nft, nftId, op.timestamp);
	if (hadExpiredListing) {
		log.info("Transfer auto-cleared expired listing", { nftId, block: op.blockNum });
	}
	assertSeedNotDistributed(nft, nftId);

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable`);
	}

	await updateNftOwner(nftId, to, op.txId, txn);
	await deleteNftAllowance(nftId, txn);
}
