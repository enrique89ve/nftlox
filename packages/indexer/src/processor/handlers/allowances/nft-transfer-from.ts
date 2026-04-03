import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import {
	getNftAllowance,
	hasCollectionAllowance,
	deleteNftAllowance,
} from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertOwnershipChangeable, assertNotSeed } from "@/utils/status-checks.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("handler:nft-transfer-from");

export async function handleNftTransferFrom(op: ParsedOperation, txn: Queryable): Promise<void> {
	const from = requireUsername(op.data.from, "from");
	const to = requireUsername(op.data.to, "to");
	const instanceId = requireString(op.data.instanceId, "instanceId");

	if (from === to) throw new Error("Cannot transfer to yourself");

	const nft = await getNftForProcessing(instanceId, txn);
	if (!nft) throw new Error(`NFT not found: ${instanceId}`);

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

	await updateNftOwner(instanceId, to, op.txId, txn);
	await deleteNftAllowance(instanceId, txn);
	// NOTE: collection_allowances are NOT cleaned here — the owner explicitly
	// granted collection-wide approval and a spender action should not revoke it.
	// Cleanup only happens on direct transfer/burn where the owner acts.
}
