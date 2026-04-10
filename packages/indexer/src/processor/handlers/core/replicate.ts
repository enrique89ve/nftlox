import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { insertNft, nftExists, getNftForProcessing, updateNftListing } from "@/db/queries/nfts.ts";
import type { ListingCtx } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { requireBoundedString, requireUsername, optionalString } from "@/utils/validation.ts";
import { assertTransferable } from "@/utils/status-checks.ts";
// NOTE: replicate uses assertTransferable (not assertOwnershipChangeable) because
// replication doesn't change ownership of the original — it creates a copy.
import {
	ACTION_REPLICATE,
	generateReplicaInstanceDna,
	MAX_ID_LENGTH,
} from "@/protocol/index.ts";

export async function handleReplicate(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const d = op.data;
	const id = requireBoundedString(d.id, "id", MAX_ID_LENGTH);
	const originalId = requireBoundedString(d.originalId, "originalId", MAX_ID_LENGTH);
	const newOwner = requireUsername(d.newOwner, "newOwner");

	if (await nftExists(id, txn)) throw new Error(`Replica already exists: ${id}`);
	const original = await getNftForProcessing(originalId, txn);
	if (!original) throw new Error(`Original NFT not found: ${originalId}`);
	if (original.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${originalId}`);

	const { hadExpiredListing } = assertTransferable(original, originalId, op.timestamp);

	// If replicating an instance, verify the parent seed still exists (not burned/deleted)
	if (original.seed_id) {
		const seed = await getNftForProcessing(original.seed_id, txn);
		if (!seed) throw new Error(`Parent seed not found (burned?): ${original.seed_id}`);
	}

	const rules = await getCollectionRules(original.collection_id, txn);
	if (!rules) throw new Error(`Collection not found: ${original.collection_id}`);
	if (!rules.replicable) {
		throw new Error(`Collection ${original.collection_id} is not replicable`);
	}

	// DNA is always computed by the indexer — never trust user-supplied values.
	const [dnaRow] = await txn`SELECT origin_dna FROM nfts WHERE id = ${originalId}`;
	const originDna = (dnaRow?.origin_dna as string) ?? null;
	const instanceDna = originDna && original.instance_dna
		? await generateReplicaInstanceDna(originDna, original.instance_dna)
		: null;

	await insertNft({
		id, collectionId: original.collection_id, nftType: "replica", edition: 1,
		owner: newOwner, originDna,
		instanceDna,
		name: optionalString(d.name) ?? `${original.name} (Replica)`,
		imageUrl: null,
		maxReplicas: 0, seedId: null, instanceNumber: null, originalId,
		immutableData: null, dataOperationId: null, dataHash: null,
		schemaVersion: rules.schema_version,
		ownerOperationId: op.operationId,
		ownerAction: ACTION_REPLICATE,
		ownerBlockNum: op.blockNum,
		createdOperationId: op.operationId,
		createdBlockNum: op.blockNum,
		createdTxId: op.txId,
		createdAt: op.timestamp,
	}, txn);

	if (hadExpiredListing) {
		const ctx: ListingCtx = { collectionId: original.collection_id, wasListed: true };
		await updateNftListing(originalId, null, null, null, null, null, null, ctx, txn);
	}

	return [id];
}
