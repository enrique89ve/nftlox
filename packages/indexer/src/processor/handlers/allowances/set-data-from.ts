import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getAssetForProcessing,
	updateAssetDataRef,
} from "@/db/queries/assets.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { hasDataOperatorApproval } from "@/db/queries/allowances.ts";
import { requireString, requireObject, optionalStoredCollectionSchema } from "@/utils/validation.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { computeDataHash, validateMutableSnapshot } from "@/protocol/index.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleSetDataFrom(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const assetId = requireString(op.data.assetId, "assetId");
	const assetDna = requireString(op.data.assetDna, "assetDna");

	const asset = await getAssetForProcessing(assetId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${assetId}`);
	if (asset.asset_dna !== assetDna) throw protocolReject(`Asset DNA mismatch for ${assetId}`);

	await validateSeedProvenance(op, asset, txn);

	const isOperator = await hasDataOperatorApproval(asset.collection_id, op.signer, txn);
	if (!isOperator) {
		throw protocolReject(`Signer ${op.signer} is not an approved data operator for collection ${asset.collection_id}`);
	}

	const collection = await getCollectionRules(asset.collection_id, txn);
	const schema = optionalStoredCollectionSchema(collection?.schema);

	if (!schema) {
		throw protocolReject(`Collection ${asset.collection_id} requires a schema for set_data_from`);
	}

	// REPLACE semantics: operator sends complete data, validated against schema
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
