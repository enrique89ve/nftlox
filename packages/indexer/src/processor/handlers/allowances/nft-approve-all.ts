import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { collectionExists } from "@/db/queries/collections.ts";
import { upsertCollectionAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireBoolean } from "@/utils/validation.ts";

// Note: No history_events entry here because history_events is per-NFT (keyed on nft_id).
// Collection-wide approvals are auditable via the collection_allowances table (block_num, tx_id).

export async function handleNftApproveAll(op: ParsedOperation, txn: Queryable): Promise<void> {
	const spender = requireString(op.data.spender, "spender");
	const collectionId = requireString(op.data.collectionId, "collectionId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw new Error("Cannot approve yourself");

	const exists = await collectionExists(collectionId, txn);
	if (!exists) throw new Error(`Collection not found: ${collectionId}`);

	await upsertCollectionAllowance(
		op.signer, spender, collectionId, approved,
		op.blockNum, op.txId, txn,
	);
}
