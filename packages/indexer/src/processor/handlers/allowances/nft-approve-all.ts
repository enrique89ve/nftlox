import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	COLLECTION_STATUS_ARCHIVED,
	getCollectionRules,
} from "@/db/queries/collections.ts";
import { upsertCollectionAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireBoolean, requireUsername } from "@/utils/validation.ts";

export async function handleNftApproveAll(op: ParsedOperation, txn: Queryable): Promise<void> {
	const spender = requireUsername(op.data.spender, "spender");
	const collectionId = requireString(op.data.collectionId, "collectionId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw new Error("Cannot approve yourself");

	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.status === COLLECTION_STATUS_ARCHIVED) throw new Error(`Collection ${collectionId} is archived`);

	if (approved) {
		// Only allow approveAll if the signer owns at least one NFT in this collection
		const [row] = await txn`
			SELECT 1 FROM nfts
			WHERE owner = ${op.signer} AND collection_id = ${collectionId}
			LIMIT 1
		`;
		if (!row) throw new Error(`Signer ${op.signer} has no NFTs in collection ${collectionId}`);
	}

	await upsertCollectionAllowance(
		op.signer, spender, collectionId, approved,
		op.blockNum, op.txId, txn,
	);
}
