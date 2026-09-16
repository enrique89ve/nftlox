import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getAssetForProcessing,
	updateAssetDataRef,
} from "@/db/queries/assets.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { requireString, requireObject, optionalStoredCollectionSchema } from "@/utils/validation.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { computeDataHash, validateMutableSnapshot } from "@/protocol/index.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleSetData(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const assetId = requireString(op.data.assetId, "assetId");
	const assetDna = requireString(op.data.assetDna, "assetDna");

	const asset = await getAssetForProcessing(assetId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${assetId}`);
	if (asset.asset_dna !== assetDna) throw protocolReject(`Asset DNA mismatch for ${assetId}`);

	await validateSeedProvenance(op, asset, txn);

	const collection = await getCollectionRules(asset.collection_id, txn);
	const schema = optionalStoredCollectionSchema(collection?.schema);

	if (!schema) {
		throw protocolReject(`Collection ${asset.collection_id} requires a schema for set_data`);
	}

	// Only creator can write mutable data
	if (!collection || collection.creator !== op.signer) {
		throw protocolReject(`Signer ${op.signer} is not the creator of collection ${asset.collection_id}`);
	}

	// REPLACE semantics: caller sends complete data, validated against schema
	const mutableData = requireObject(op.data.mutableData, "mutableData") as Record<string, unknown>;
	if (Object.keys(mutableData).length === 0) {
		throw protocolReject("mutableData cannot be empty");
	}

	const errors = validateMutableSnapshot(schema, mutableData);
	if (errors.length > 0) {
		throw protocolReject(`Schema validation failed: ${formatSchemaErrors(errors)}`);
	}

	const dataHash = await computeDataHash(mutableData);

	await updateAssetDataRef(assetId, dataHash, op.operationId, txn);

	return [assetId];
}
