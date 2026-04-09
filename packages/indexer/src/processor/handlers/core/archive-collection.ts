import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	archiveCollection,
	getCollectionArchiveSnapshot,
} from "@/db/queries/collections.ts";
import { requireString } from "@/utils/validation.ts";

export async function handleArchiveCollection(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const collectionId = requireString(op.data.collectionId, "collectionId");
	const collection = await getCollectionArchiveSnapshot(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) {
		throw new Error(`Signer ${op.signer} is not creator of collection ${collectionId}`);
	}
	if (collection.nft_count > 0) {
		throw new Error(
			`Collection ${collectionId} cannot be deleted: ${collection.nft_count} NFTs still exist`,
		);
	}

	await archiveCollection(collectionId, collection.creator, op.txId, txn);

	return [];
}
