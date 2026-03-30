import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { COLLECTION_STATUS_ARCHIVED, getCollectionRules } from "@/db/queries/collections.ts";
import { insertNft, nftExists } from "@/db/queries/nfts.ts";
import { requireString, optionalString, optionalNumber, optionalObject } from "@/utils/validation.ts";
import { resolveNftType, validateSeedCap } from "@/utils/nft-rules.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import {
	validateMintData,
	computeDataHash,
	generateOriginDna,
	generateInstanceDna,
	generateDeterministicAccessKey,
	type CollectionSchema,
} from "nftlox-sdk";

export async function handleMint(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireString(d.id, "id");
	const collectionId = requireString(d.collectionId, "collectionId");

	if (await nftExists(id, txn)) return;
	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) throw new Error(`Only the collection creator can mint in ${collectionId}`);
	if (collection.status === COLLECTION_STATUS_ARCHIVED) throw new Error(`Collection ${collectionId} is archived`);

	const metadata = optionalObject(d.metadata) ?? {};
	const nftType = resolveNftType(optionalString(d.nftType), id);
	const isSeed = nftType === "seed";

	if (isSeed) {
		validateSeedCap(collectionId, collection.seed_count, collection.total_potential);
	}

	// Schema-based validation
	const schema = collection.schema as CollectionSchema | null;
	const immutableData = optionalObject(d.immutableData) as Record<string, unknown> | null;
	const mutableData = optionalObject(d.mutableData) as Record<string, unknown> | null;

	if (schema) {
		const errors = validateMintData(schema, immutableData ?? undefined, mutableData ?? undefined);
		if (errors.length > 0) {
			throw new Error(`Schema validation failed: ${formatSchemaErrors(errors)}`);
		}
	}

	const immutableDataHash = immutableData ? await computeDataHash(immutableData) : null;
	const mutableDataHash = mutableData ? await computeDataHash(mutableData) : null;

	// DNA is always computed by the indexer — never trust user-supplied values.
	// This guarantees every NFT has a verifiable, deterministic DNA chain.
	const edition = optionalNumber(d.edition) ?? 1;
	const imageHash = optionalString(metadata.imageHash) ?? "";
	const originDna = await generateOriginDna(collectionId);
	const instanceDna = await generateInstanceDna(id, originDna, edition, imageHash);
	const uniqueAccessKey = await generateDeterministicAccessKey(instanceDna, op.signer, op.txId);

	await insertNft({
		id, collectionId, nftType: isSeed ? "seed" : "instance",
		edition,
		owner: optionalString(d.owner) ?? op.signer,
		originDna,
		instanceDna,
		uniqueAccessKey,
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
