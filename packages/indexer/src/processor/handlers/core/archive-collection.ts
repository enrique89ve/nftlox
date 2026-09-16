import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	archiveCollection,
	getCollectionArchiveSnapshot,
} from "@/db/queries/collections.ts";
import { requireString } from "@/utils/validation.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleArchiveCollection(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const collectionId = requireString(op.data.collectionId, "collectionId");
	const collection = await getCollectionArchiveSnapshot(collectionId, txn);
	if (!collection) throw protocolReject(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) {
		throw protocolReject(`Signer ${op.signer} is not creator of collection ${collectionId}`);
	}
	if (collection.asset_count > 0) {
		throw protocolReject(
			`Collection ${collectionId} cannot be deleted: ${collection.asset_count} Assets still exist`,
		);
	}

	await archiveCollection(collectionId, collection.creator, op.txId, txn);

	return [];
}
