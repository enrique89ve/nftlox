import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessingForUpdate, updateNftOwner } from "@/db/queries/nfts.ts";
import type { OwnerChangeCtx } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import {
	getNftAllowance,
	hasCollectionAllowance,
	deleteNftAllowance,
	cleanupCollectionAllowancesIfEmpty,
} from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertOwnershipChangeable, assertNotPendingSale, assertNotSeed } from "@/utils/status-checks.ts";
import { createLogger } from "@/utils/logger.ts";
import { ACTION_NFT_TRANSFER_FROM } from "@/protocol/index.ts";

const log = createLogger("handler:nft-transfer-from");

export async function handleNftTransferFrom(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const from = requireUsername(op.data.from, "from");
	const to = requireUsername(op.data.to, "to");
	const instanceId = requireString(op.data.instanceId, "instanceId");

	if (from === to) throw new Error("Cannot transfer to yourself");

	const nft = await getNftForProcessingForUpdate(instanceId, txn);
	if (!nft) throw new Error(`NFT not found: ${instanceId}`);

	// Delegated transfer on a `pending_sale` row would race the buy_commitment
	// of another buyer. Reject before we touch allowance tables so the
	// savepoint rolls back clean.
	assertNotPendingSale(nft, instanceId);

	const { hadExpiredListing } = assertOwnershipChangeable(nft, instanceId, op.timestamp);
	if (hadExpiredListing) {
		log.info("TransferFrom auto-cleared expired listing", { instanceId, block: op.blockNum });
	}
	assertNotSeed(nft, instanceId);

	if (nft.owner !== from) throw new Error(`Account ${from} is not owner of ${instanceId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable`);
	}

	// Spender authorization: individual NFT approval OR collection-wide approval
	const approvedSpender = await getNftAllowance(instanceId, txn);
	const hasIndividualApproval = approvedSpender === op.signer;
	const hasCollectionApproval = await hasCollectionAllowance(
		from, op.signer, nft.collection_id, txn,
	);

	if (!hasIndividualApproval && !hasCollectionApproval) {
		throw new Error(`Signer ${op.signer} is not approved to transfer ${instanceId}`);
	}

	const ctx: OwnerChangeCtx = {
		oldOwner: nft.owner,
		nftType: nft.nft_type,
		collectionId: nft.collection_id,
		ownerAction: ACTION_NFT_TRANSFER_FROM,
		ownerBlockNum: op.blockNum,
		wasListed: hadExpiredListing,
	};
	await updateNftOwner(instanceId, to, op.operationId, ctx, txn);
	await deleteNftAllowance(instanceId, txn);
	// Invariant A4': collection_allowances(owner=X, collection=Y) MUST be
	// revoked the moment owner_count(X, Y) transitions to 0 — regardless of
	// which action caused it. If `from` emptied their holdings in this
	// collection via this delegated transfer, keeping the approval would
	// create a zombie authority that silently re-activates the next time
	// `from` acquires any NFT in the same collection.
	await cleanupCollectionAllowancesIfEmpty(from, nft.collection_id, txn);

	return [instanceId];
}
