import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { insertCollection, collectionExists } from "@/db/queries/collections.ts";
import { requireString, optionalString, optionalNumber, optionalBoolean, optionalObject } from "@/utils/validation.ts";
import { validateSchemaDefinition, type CollectionSchema } from "nftlox-sdk";

export async function handleCreateCollection(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireString(d.id, "id");

	if (await collectionExists(id, txn)) {
		throw new Error(`Collection already exists: ${id}`);
	}

	const metadata = optionalObject(d.metadata) ?? {};
	const rules = optionalObject(d.rules) ?? {};

	// Validate schema if provided
	const rawSchema = optionalObject(d.schema) as CollectionSchema | null;
	if (rawSchema) {
		const schemaErrors = validateSchemaDefinition(rawSchema);
		if (schemaErrors.length > 0) {
			const messages = schemaErrors.map((e) => `${e.field}: ${e.message}`).join("; ");
			throw new Error(`Invalid schema: ${messages}`);
		}
	}

	await insertCollection({
		id,
		jsonId: optionalString(d.jsonId),
		name: requireString(d.name, "name"),
		symbol: requireString(d.symbol, "symbol"),
		creator: op.signer,
		totalPotential: optionalNumber(d.totalPotential) ?? 0,
		originDna: optionalString(d.originDna),
		description: optionalString(metadata.description),
		imageUrl: optionalString(metadata.image),
		externalUrl: optionalString(metadata.externalUrl),
		transferable: optionalBoolean(rules.transferable, true),
		burnable: optionalBoolean(rules.burnable, true),
		replicable: optionalBoolean(rules.replicable, true),
		royaltyPct: optionalNumber(rules.royaltyPct) ?? 0,
		royaltyRecipient: optionalString(rules.royaltyRecipient),
		schema: rawSchema,
		blockNum: op.blockNum,
		txId: op.txId,
		createdAt: op.timestamp,
	}, txn);
}
