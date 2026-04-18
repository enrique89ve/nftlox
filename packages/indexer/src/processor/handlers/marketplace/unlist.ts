import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, getNftForProcessingForUpdate, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import { markPendingUnlist } from "@/db/queries/nft-mutations.ts";
import { requireString } from "@/utils/validation.ts";
import { assertNoActiveMultisigLock } from "@/utils/multisig-locks.ts";

/**
 * Unlist marks the NFT with `pending_unlist_block = op.blockNum` and leaves
 * `status = 'listed'` in place. The sync engine materializes the unlist at
 * block close once `op.blockNum + UNLIST_DELAY_BLOCKS` has elapsed. The delay
 * gives any in-flight multisig-signed buy (whose lock already lives in
 * `multisig_locks`) a deterministic window to land before the NFT is pulled
 * off the market. Because the delay is counted in block numbers, every node
 * materializes identically — no divergence possible.
 *
 * The multisig lock is also checked explicitly so a non-matching unlist
 * (malicious or stale) is rejected up-front rather than silently papered
 * over by pending_unlist_block.
 */
export async function handleUnlist(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const nftId = requireString(op.data.nftId, "nftId");
	await assertNoActiveMultisigLock(nftId, op.timestamp, txn);

	const nft = await getNftForProcessingForUpdate(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status !== NFT_STATUS_LISTED) throw new Error(`NFT not listed: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);
	if (nft.pending_unlist_block !== null) {
		throw new Error(`NFT ${nftId} already has a pending unlist at block ${nft.pending_unlist_block}`);
	}

	await markPendingUnlist(nftId, op.blockNum, txn);

	return [nftId];
}
