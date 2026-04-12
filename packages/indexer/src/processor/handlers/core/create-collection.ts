import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { insertCollection, collectionExists, symbolTakenByCreator, countCollectionsByCreator } from "@/db/queries/collections.ts";
import { insertSchemaVersion } from "@/db/queries/schema-versions.ts";
import { feeOracle } from "@/utils/fee-oracle.ts";
import { assertWithinLimit } from "@/utils/action-limits.ts";
import { config } from "@/config.ts";
import {
	requireBoundedString,
	requireSymbol,
	requireNumber,
	requireObject,
	requireBoolean,
	optionalString,
	optionalBoundedString,
	optionalCollectionSchema,
	collectionSchemaToRecord,
	requireUsername,
} from "@/utils/validation.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import {
	validateSchemaDefinition,
	computeDataHash,
	generateDeterministicCollectionId,
	MAX_NAME_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	MAX_URL_LENGTH,
	MAX_ID_LENGTH,
	PROTOCOL_COLLECTION_FEE_HBD,
} from "@/protocol/index.ts";

export async function handleCreateCollection(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	if (op.signer !== config.hiveAccount) {
		throw new Error(
			`create_collection must be signed by node account '${config.hiveAccount}', got '${op.signer}'`,
		);
	}

	const rawCreator = op.pairedTransfers?.[0]?.from;
	if (!rawCreator) throw new Error("No fee transfer found for create_collection action");
	const creator = requireUsername(rawCreator, "creator");

	const d = op.data;
	const payloadId = requireBoundedString(d.id, "id", MAX_ID_LENGTH);
	const name = requireBoundedString(d.name, "name", MAX_NAME_LENGTH);
	const symbol = requireSymbol(d.symbol, "symbol");

	// C4: Recalculate canonical collectionId and reject mismatch
	const canonicalId = await generateDeterministicCollectionId(creator, name, symbol);
	if (payloadId !== canonicalId) {
		throw new Error(
			`Non-canonical collectionId: expected ${canonicalId}, got ${payloadId}`,
		);
	}

	if (await collectionExists(canonicalId, txn)) return [];

	const transfer = await feeOracle.requireDynamicFee(op, PROTOCOL_COLLECTION_FEE_HBD, config.hiveAccount, creator);
	const feePaidHbd = transfer.currency === "HBD" ? transfer.amount : 0;
	const feePaidHive = transfer.currency === "HIVE" ? transfer.amount : 0;

	const creatorCollectionCount = await countCollectionsByCreator(creator, txn);
	await assertWithinLimit("collectionsPerCreator", creator, creatorCollectionCount);

	if (await symbolTakenByCreator(creator, symbol, txn)) {
		throw new Error(`Symbol ${symbol} already used by @${creator}`);
	}

	// H3: Require metadata with mandatory fields
	const metadata = requireObject(d.metadata, "metadata");
	const description = requireBoundedString(metadata.description, "metadata.description", MAX_DESCRIPTION_LENGTH);
	const imageUrl = requireBoundedString(metadata.image, "metadata.image", MAX_IMAGE_URL_LENGTH);

	// H4: Require rules with explicit boolean fields
	const rules = requireObject(d.rules, "rules");
	const transferable = requireBoolean(rules.transferable, "rules.transferable");
	const burnable = requireBoolean(rules.burnable, "rules.burnable");
	const royaltyPct = requireNumber(rules.royaltyPct, "rules.royaltyPct");
	if (royaltyPct < 0 || royaltyPct > 50) {
		throw new Error(`royaltyPct must be between 0 and 50, got ${royaltyPct}`);
	}

	const totalPotential = requireNumber(d.totalPotential, "totalPotential");
	if (totalPotential < 0 || !Number.isInteger(totalPotential)) {
		throw new Error(`totalPotential must be a non-negative integer, got ${totalPotential}`);
	}

	// Validate schema if provided
	const rawSchema = optionalCollectionSchema(d.schema);
	if (rawSchema) {
		const schemaErrors = validateSchemaDefinition(rawSchema);
		if (schemaErrors.length > 0) {
			throw new Error(`Invalid schema: ${formatSchemaErrors(schemaErrors)}`);
		}
	}

	const schemaVersion = rawSchema ? 1 : 0;

	await insertCollection({
		id: canonicalId,
		name,
		symbol,
		creator,
		totalPotential,
		description,
		imageUrl,
		externalUrl: optionalBoundedString(metadata.externalUrl, "metadata.externalUrl", MAX_URL_LENGTH),
		transferable,
		burnable,
		royaltyPct,
		royaltyRecipient: optionalString(rules.royaltyRecipient),
		feePaidHbd,
		feePaidHive,
		schema: rawSchema,
		schemaVersion,
		blockNum: op.blockNum,
		txId: op.txId,
		createdAt: op.timestamp,
	}, txn);

	if (rawSchema) {
		const schemaHash = await computeDataHash(collectionSchemaToRecord(rawSchema));
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

	return [];
}
