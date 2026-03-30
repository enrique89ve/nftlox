import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	archiveCollection,
	COLLECTION_STATUS_ARCHIVED,
	getCollectionArchiveSnapshot,
} from "@/db/queries/collections.ts";
import {
	deleteCollectionAllowancesByCollection,
	deleteDataOperatorsByCollection,
} from "@/db/queries/allowances.ts";
import { requireString } from "@/utils/validation.ts";

export async function handleArchiveCollection(op: ParsedOperation, txn: Queryable): Promise<void> {
	const collectionId = requireString(op.data.collectionId, "collectionId");
	const collection = await getCollectionArchiveSnapshot(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) {
		throw new Error(`Signer ${op.signer} is not creator of collection ${collectionId}`);
	}
	if (collection.status === COLLECTION_STATUS_ARCHIVED) return;
	if (collection.nft_count > 0) {
		throw new Error(
			`Collection ${collectionId} cannot be archived: ${collection.nft_count} NFTs still exist`,
		);
	}
	if (collection.pack_count > 0) {
		throw new Error(
			`Collection ${collectionId} cannot be archived: ${collection.pack_count} packs still exist`,
		);
	}

	await deleteCollectionAllowancesByCollection(collectionId, txn);
	await deleteDataOperatorsByCollection(collectionId, txn);
	await archiveCollection(collectionId, op.blockNum, op.txId, op.timestamp, txn);
}
