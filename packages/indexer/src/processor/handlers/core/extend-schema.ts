import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	COLLECTION_STATUS_ARCHIVED,
	getCollectionRules,
	updateCollectionSchema,
} from "@/db/queries/collections.ts";
import { getLatestSchemaVersion, insertSchemaVersion } from "@/db/queries/schema-versions.ts";
import {
	requireString,
	optionalCollectionSchema,
	optionalSchemaFieldArray,
	collectionSchemaToRecord,
} from "@/utils/validation.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import {
	mergeSchemas,
	validateSchemaDefinition,
	computeDataHash,
	type CollectionSchema,
} from "@/protocol/index.ts";

export async function handleExtendSchema(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const collectionId = requireString(op.data.collectionId, "collectionId");

	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) {
		throw new Error(`Signer ${op.signer} is not the creator of collection ${collectionId}`);
	}
	if (collection.status === COLLECTION_STATUS_ARCHIVED) throw new Error(`Collection ${collectionId} is archived`);

	const newImmutableFields = optionalSchemaFieldArray(
		op.data.newImmutableFields,
		"newImmutableFields",
	);
	const newMutableFields = optionalSchemaFieldArray(
		op.data.newMutableFields,
		"newMutableFields",
	);

	const existingSchema = optionalCollectionSchema(collection.schema);
	let finalSchema: CollectionSchema;

	if (existingSchema) {
		const { merged, errors } = mergeSchemas(existingSchema, { newImmutableFields, newMutableFields });
		if (errors.length > 0) {
			throw new Error(`Schema extension failed: ${formatSchemaErrors(errors)}`);
		}
		finalSchema = merged;
	} else {
		finalSchema = {
			immutable: newImmutableFields ?? [],
			mutable: newMutableFields ?? [],
		};
		const errors = validateSchemaDefinition(finalSchema);
		if (errors.length > 0) {
			throw new Error(`Schema validation failed: ${formatSchemaErrors(errors)}`);
		}
	}

	const prev = await getLatestSchemaVersion(collectionId, txn);
	const newVersion = (prev?.version ?? 0) + 1;
	const schemaHash = await computeDataHash(collectionSchemaToRecord(finalSchema));

	await insertSchemaVersion({
		collectionId,
		version: newVersion,
		schema: finalSchema,
		schemaHash,
		prevHash: prev?.schema_hash ?? null,
		blockNum: op.blockNum,
		txId: op.txId,
		createdAt: op.timestamp,
	}, txn);

	await updateCollectionSchema(collectionId, finalSchema, newVersion, txn);

	return [];
}
