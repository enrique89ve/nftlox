import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { insertNft, nftExists, getNftForProcessing, updateNftListing } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { requireString, requireUsername, optionalString } from "@/utils/validation.ts";
import { assertTransferable, assertNotBurned } from "@/utils/status-checks.ts";
import {
	generateReplicaInstanceDna,
	generateDeterministicAccessKey,
} from "nftlox-sdk";

export async function handleReplicate(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireString(d.id, "id");
	const originalId = requireString(d.originalId, "originalId");
	const newOwner = requireUsername(d.newOwner, "newOwner");

	if (await nftExists(id, txn)) throw new Error(`Replica already exists: ${id}`);
	const original = await getNftForProcessing(originalId, txn);
	if (!original) throw new Error(`Original NFT not found: ${originalId}`);
	if (original.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${originalId}`);

	const { hadExpiredListing } = assertTransferable(original, originalId, op.timestamp);

	// If replicating an instance, verify the parent seed is not burned
	if (original.seed_id) {
		const seed = await getNftForProcessing(original.seed_id, txn);
		if (seed) assertNotBurned(seed, original.seed_id);
	}

	const rules = await getCollectionRules(original.collection_id, txn);
	if (!rules) throw new Error(`Collection not found: ${original.collection_id}`);
	if (!rules.replicable) {
		throw new Error(`Collection ${original.collection_id} is not replicable`);
	}

	// DNA is always computed by the indexer — never trust user-supplied values.
	// Fetch origin_dna from DB since NftProcessingRow doesn't include it.
	const [dnaRow] = await txn`SELECT origin_dna FROM nfts WHERE id = ${originalId}`;
	const originDna = (dnaRow?.origin_dna as string) ?? null;
	const instanceDna = originDna && original.instance_dna
		? await generateReplicaInstanceDna(originDna, original.instance_dna)
		: null;
	const uniqueAccessKey = instanceDna
		? await generateDeterministicAccessKey(instanceDna, newOwner, op.txId)
		: null;

	await insertNft({
		id, collectionId: original.collection_id, nftType: "replica", edition: 1,
		owner: newOwner, originDna,
		instanceDna, uniqueAccessKey,
		mintedBy: op.signer,
		name: optionalString(d.name) ?? `${original.name} (Replica)`,
		description: null, imageUrl: null, imageHash: null,
		maxReplicas: 0, seedId: null, instanceNumber: null, originalId,
		immutableData: null, immutableDataHash: null,
		mutableData: null, mutableDataHash: null,
		schemaVersion: rules.schema_version,
		blockNum: op.blockNum, txId: op.txId, createdAt: op.timestamp,
	}, txn);

	if (hadExpiredListing) {
		await updateNftListing(originalId, null, null, null, null, null, null, txn);
	}
}
