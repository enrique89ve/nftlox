import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getNftForProcessing,
	updateNftDataRef,
} from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { requireString, requireObject, optionalCollectionSchema } from "@/utils/validation.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { computeDataHash, validateMutableSnapshot } from "@/protocol/index.ts";

export async function handleSetData(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const nftId = requireString(op.data.nftId, "nftId");
	const instanceDna = requireString(op.data.instanceDna, "instanceDna");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.instance_dna !== instanceDna) throw new Error(`Instance DNA mismatch for ${nftId}`);

	const collection = await getCollectionRules(nft.collection_id, txn);
	const schema = optionalCollectionSchema(collection?.schema);

	if (!schema) {
		throw new Error(`Collection ${nft.collection_id} requires a schema for set_data`);
	}

	// Only creator can write mutable data
	if (!collection || collection.creator !== op.signer) {
		throw new Error(`Signer ${op.signer} is not the creator of collection ${nft.collection_id}`);
	}

	// REPLACE semantics: caller sends complete data, validated against schema
	const mutableData = requireObject(op.data.mutableData, "mutableData") as Record<string, unknown>;
	if (Object.keys(mutableData).length === 0) {
		throw new Error("mutableData cannot be empty");
	}

	const errors = validateMutableSnapshot(schema, mutableData);
	if (errors.length > 0) {
		throw new Error(`Schema validation failed: ${formatSchemaErrors(errors)}`);
	}

	const dataHash = await computeDataHash(mutableData);

	await updateNftDataRef(nftId, dataHash, op.operationId, txn);

	return [nftId];
}
