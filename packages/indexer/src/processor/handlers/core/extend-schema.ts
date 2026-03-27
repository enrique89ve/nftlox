import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getCollectionRules, updateCollectionSchema } from "@/db/queries/collections.ts";
import { requireString } from "@/utils/validation.ts";
import { mergeSchemas, validateSchemaDefinition, type CollectionSchema, type SchemaField } from "nftlox-sdk";

export async function handleExtendSchema(op: ParsedOperation, txn: Queryable): Promise<void> {
	const collectionId = requireString(op.data.collectionId, "collectionId");

	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) {
		throw new Error(`Signer ${op.signer} is not the creator of collection ${collectionId}`);
	}

	const newImmutableFields = Array.isArray(op.data.newImmutableFields)
		? op.data.newImmutableFields as SchemaField[]
		: undefined;
	const newMutableFields = Array.isArray(op.data.newMutableFields)
		? op.data.newMutableFields as SchemaField[]
		: undefined;

	const existingSchema = collection.schema as CollectionSchema | null;

	if (existingSchema) {
		const { merged, errors } = mergeSchemas(existingSchema, { newImmutableFields, newMutableFields });
		if (errors.length > 0) {
			const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
			throw new Error(`Schema extension failed: ${messages}`);
		}
		await updateCollectionSchema(collectionId, merged, txn);
	} else {
		// First schema creation via extend_schema
		const newSchema: CollectionSchema = {
			immutable: newImmutableFields ?? [],
			mutable: newMutableFields ?? [],
		};

		const errors = validateSchemaDefinition(newSchema);
		if (errors.length > 0) {
			const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
			throw new Error(`Schema validation failed: ${messages}`);
		}

		await updateCollectionSchema(collectionId, newSchema, txn);
	}
}
