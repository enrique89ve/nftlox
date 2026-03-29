import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { insertNft, nftExists } from "@/db/queries/nfts.ts";
import { requireString, optionalString, optionalNumber, optionalObject } from "@/utils/validation.ts";
import { validateMintData, computeDataHash, type CollectionSchema } from "nftlox-sdk";

export async function handleMint(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireString(d.id, "id");
	const collectionId = requireString(d.collectionId, "collectionId");

	if (await nftExists(id, txn)) return;
	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) throw new Error(`Only the collection creator can mint in ${collectionId}`);

	const metadata = optionalObject(d.metadata) ?? {};
	const explicitType = optionalString(d.nftType);
	const isSeed = explicitType === "seed" || (!explicitType && id.startsWith("seed_"));

	if (isSeed && collection.total_potential > 0 && collection.seed_count >= collection.total_potential) {
		throw new Error(
			`Collection ${collectionId} reached its seed cap: ${collection.seed_count}/${collection.total_potential}`,
		);
	}

	// Schema-based validation
	const schema = collection.schema as CollectionSchema | null;
	const immutableData = optionalObject(d.immutableData) as Record<string, unknown> | null;
	const mutableData = optionalObject(d.mutableData) as Record<string, unknown> | null;

	if (schema) {
		const errors = validateMintData(schema, immutableData ?? undefined, mutableData ?? undefined);
		if (errors.length > 0) {
			const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
			throw new Error(`Schema validation failed: ${messages}`);
		}
	}

	const immutableDataHash = immutableData ? await computeDataHash(immutableData) : null;
	const mutableDataHash = mutableData ? await computeDataHash(mutableData) : null;

	await insertNft({
		id, collectionId, nftType: isSeed ? "seed" : "instance",
		edition: optionalNumber(d.edition) ?? 1,
		owner: optionalString(d.owner) ?? op.signer,
		originDna: optionalString(d.originDna),
		instanceDna: optionalString(d.instanceDna),
		uniqueAccessKey: optionalString(d.uniqueAccessKey),
		birthBlock: op.blockNum,
		birthTx: op.txId,
		mintedBy: op.signer,
		name: optionalString(metadata.name) ?? optionalString(d.name) ?? "",
		description: optionalString(metadata.description),
		imageUrl: optionalString(metadata.imageUrl),
		imageHash: optionalString(metadata.imageHash),
		maxReplicas: optionalNumber(d.maxReplicas) ?? 1,
		seedId: null, instanceNumber: null, originalId: null,
		immutableData, immutableDataHash,
		mutableData, mutableDataHash,
		blockNum: op.blockNum, txId: op.txId, createdAt: op.timestamp,
	}, txn);
}
