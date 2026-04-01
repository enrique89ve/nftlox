import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { insertCollection, collectionExists, symbolTakenByCreator } from "@/db/queries/collections.ts";
import { insertSchemaVersion } from "@/db/queries/schema-versions.ts";
import {
	requireString,
	requireSymbol,
	requireNumber,
	requireObject,
	requireBoolean,
	optionalString,
	optionalObject,
} from "@/utils/validation.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import {
	validateSchemaDefinition,
	computeDataHash,
	generateDeterministicCollectionId,
	generateOriginDna,
	type CollectionSchema,
} from "nftlox-sdk";

export async function handleCreateCollection(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const payloadId = requireString(d.id, "id");
	const name = requireString(d.name, "name");
	const symbol = requireSymbol(d.symbol, "symbol");

	// C4: Recalculate canonical collectionId and reject mismatch
	const canonicalId = await generateDeterministicCollectionId(op.signer, name, symbol);
	if (payloadId !== canonicalId) {
		throw new Error(
			`Non-canonical collectionId: expected ${canonicalId}, got ${payloadId}`,
		);
	}

	if (await collectionExists(canonicalId, txn)) return;

	if (await symbolTakenByCreator(op.signer, symbol, txn)) {
		throw new Error(`Symbol ${symbol} already used by @${op.signer}`);
	}

	// H3: Require metadata with mandatory fields
	const metadata = requireObject(d.metadata, "metadata");
	const description = requireString(metadata.description, "metadata.description");
	const imageUrl = requireString(metadata.image, "metadata.image");

	// H4: Require rules with explicit boolean fields
	const rules = requireObject(d.rules, "rules");
	const transferable = requireBoolean(rules.transferable, "rules.transferable");
	const burnable = requireBoolean(rules.burnable, "rules.burnable");
	const replicable = requireBoolean(rules.replicable, "rules.replicable");
	const royaltyPct = requireNumber(rules.royaltyPct, "rules.royaltyPct");
	if (royaltyPct < 0 || royaltyPct > 50) {
		throw new Error(`royaltyPct must be between 0 and 50, got ${royaltyPct}`);
	}

	const totalPotential = requireNumber(d.totalPotential, "totalPotential");
	if (totalPotential < 0 || !Number.isInteger(totalPotential)) {
		throw new Error(`totalPotential must be a non-negative integer, got ${totalPotential}`);
	}

	// C5: Always compute canonical originDna — ignore payload value
	const originDna = await generateOriginDna(canonicalId);

	// Validate schema if provided
	const rawSchema = optionalObject(d.schema) as CollectionSchema | null;
	if (rawSchema) {
		const schemaErrors = validateSchemaDefinition(rawSchema);
		if (schemaErrors.length > 0) {
			throw new Error(`Invalid schema: ${formatSchemaErrors(schemaErrors)}`);
		}
	}

	const schemaVersion = rawSchema ? 1 : 0;

	await insertCollection({
		id: canonicalId,
		jsonId: null,
		name,
		symbol,
		creator: op.signer,
		totalPotential,
		originDna,
		description,
		imageUrl,
		externalUrl: optionalString(metadata.externalUrl),
		transferable,
		burnable,
		replicable,
		royaltyPct,
		royaltyRecipient: optionalString(rules.royaltyRecipient),
		schema: rawSchema,
		schemaVersion,
		blockNum: op.blockNum,
		txId: op.txId,
		createdAt: op.timestamp,
	}, txn);

	if (rawSchema) {
		const schemaHash = await computeDataHash(rawSchema as unknown as Record<string, unknown>);
		await insertSchemaVersion({
			collectionId: canonicalId,
			version: 1,
			schema: rawSchema,
			schemaHash,
			prevHash: null,
			blockNum: op.blockNum,
			txId: op.txId,
			createdAt: op.timestamp,
		}, txn);
	}
}
