import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	COLLECTION_STATUS_ARCHIVED,
	getCollectionRules,
	updateCollectionSchema,
} from "@/db/queries/collections.ts";
import { getLatestSchemaVersion, insertSchemaVersion } from "@/db/queries/schema-versions.ts";
import { requireString } from "@/utils/validation.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import {
	mergeSchemas,
	validateSchemaDefinition,
	computeDataHash,
	type CollectionSchema,
	type SchemaField,
} from "nftlox-sdk";

export async function handleExtendSchema(op: ParsedOperation, txn: Queryable): Promise<void> {
	const collectionId = requireString(op.data.collectionId, "collectionId");

	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) {
		throw new Error(`Signer ${op.signer} is not the creator of collection ${collectionId}`);
	}
	if (collection.status === COLLECTION_STATUS_ARCHIVED) throw new Error(`Collection ${collectionId} is archived`);

	const newImmutableFields = Array.isArray(op.data.newImmutableFields)
		? op.data.newImmutableFields as SchemaField[]
		: undefined;
	const newMutableFields = Array.isArray(op.data.newMutableFields)
		? op.data.newMutableFields as SchemaField[]
		: undefined;

	const existingSchema = collection.schema as CollectionSchema | null;
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
	const schemaHash = await computeDataHash(finalSchema as unknown as Record<string, unknown>);

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
}
