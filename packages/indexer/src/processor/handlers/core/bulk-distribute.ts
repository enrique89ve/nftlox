import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	insertNft,
	nftExists,
	getSeedWithSchemaForUpdate,
	incrementDistributedBy,
} from "@/db/queries/nfts.ts";
import { assertActionable } from "@/utils/status-checks.ts";
import {
	requireString,
	requirePositiveInt,
	requireObject,
	requireArray,
	optionalString,
	optionalObject,
	optionalCollectionSchema,
} from "@/utils/validation.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { computeInstanceBaseline, validateSeedSupplyForDistribution } from "@/utils/nft-rules.ts";
import {
	generateDeterministicInstanceId,
	generateOriginDna,
	generateDeterministicInstanceDna,
	MAX_BULK_DISTRIBUTE_ITEMS,
	validateHiveUsername,
	computeDataHash,
	validateMutableUpdate,
} from "@/protocol/index.ts";

export async function handleBulkDistribute(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const toRaw = optionalString(op.data.to);
	if (toRaw) {
		const error = validateHiveUsername(toRaw);
		if (error) throw new Error(`Invalid Hive username for to ("${toRaw}"): ${error}`);
	}
	const to = toRaw ?? op.signer;
	const items = requireArray(op.data.items, "items");
	const mutableData = optionalObject(op.data.mutableData);

	const dataHash = mutableData ? await computeDataHash(mutableData) : null;

	if (items.length === 0) throw new Error("Items array is empty");
	if (items.length > MAX_BULK_DISTRIBUTE_ITEMS) {
		throw new Error(`Too many distinct seeds: ${items.length} exceeds max ${MAX_BULK_DISTRIBUTE_ITEMS}`);
	}

	const parsedItems: Array<{ seedId: string; quantity: number; seedTxId: string }> = [];
	const affectedNftIds: string[] = [];
	const seenSeeds = new Set<string>();

	for (const item of items) {
		const raw = requireObject(item, "items[]");
		const seedId = requireString(raw.seedId, "seedId");
		const quantity = requirePositiveInt(raw.quantity, "quantity");
		const seedTxId = requireString(raw.seedTxId, "seedTxId");
		if (seenSeeds.has(seedId)) throw new Error(`Duplicate seedId in items: ${seedId}`);
		seenSeeds.add(seedId);
		parsedItems.push({ seedId, quantity, seedTxId });
	}

	// Track validated schemas to avoid re-validating mutableData per collection
	const validatedSchemas = new Set<string>();

	for (const { seedId, quantity, seedTxId } of parsedItems) {
		const seed = await getSeedWithSchemaForUpdate(seedId, txn);
		if (!seed) throw new Error(`Seed not found: ${seedId}`);
		assertActionable(seed, seedId);
		if (seed.nft_type !== "seed") throw new Error(`${seedId} is not a seed`);

		if (seed.created_tx_id !== seedTxId) {
			throw new Error(`Invalid seedTxId for ${seedId}: expected ${seed.created_tx_id}, got ${seedTxId}`);
		}

		if (seed.owner !== op.signer) {
			throw new Error(`Signer ${op.signer} is not the owner of seed ${seedId}`);
		}

		if (!validatedSchemas.has(seed.collection_id)) {
			validatedSchemas.add(seed.collection_id);
			const schema = optionalCollectionSchema(seed.schema);
			if (schema && mutableData) {
				const errors = validateMutableUpdate(schema, mutableData);
				if (errors.length > 0) {
					throw new Error(`Schema validation failed for bulk_distribute mutableData: ${formatSchemaErrors(errors)}`);
				}
			}
		}

		const distributed = Number(seed.distributed) || 0;
		const maxReplicas = Number(seed.max_replicas) || 0;

		// Idempotency: count instances already created by THIS operation.
		const [existingFromOp] = await txn`
			SELECT COUNT(*)::int AS count FROM nfts
			WHERE seed_id = ${seedId}
				AND created_operation_id = ${op.operationId}
		`;
		const alreadyMintedThisOp = existingFromOp?.count ?? 0;
		const baseDistributed = computeInstanceBaseline(distributed, alreadyMintedThisOp);

		const reservedSupply = Number(seed.reserved_supply) || 0;
		validateSeedSupplyForDistribution(seedId, maxReplicas, baseDistributed, quantity, reservedSupply);

		const originDna = await generateOriginDna(seed.collection_id);

		let minted = 0;

		for (let i = 0; i < quantity; i++) {
			const instanceNumber = baseDistributed + i + 1;
			const instanceId = await generateDeterministicInstanceId(seedId, instanceNumber);

			if (await nftExists(instanceId, txn)) continue;

			const instanceDna = await generateDeterministicInstanceDna(
				seedId, instanceNumber, op.txId, op.blockNum,
			);

			// Instance stores only references; name, image are inherited from seed via JOIN at query time.
			await insertNft({
				id: instanceId,
				collectionId: seed.collection_id,
				nftType: "instance",
				edition: 1,
				owner: to,
				originDna,
				instanceDna,
				name: "",
				imageUrl: null,
				maxReplicas: 0,
				seedId,
				instanceNumber,
				originalId: null,
				immutableData: null,
				dataOperationId: mutableData ? op.operationId : null,
				dataHash,
				schemaVersion: seed.schema_version,
				ownerOperationId: op.operationId,
				createdOperationId: op.operationId,
				createdBlockNum: op.blockNum,
				createdTxId: op.txId,
				createdAt: op.timestamp,
			}, txn);

			affectedNftIds.push(instanceId);
			minted++;
		}

		if (minted > 0) {
			await incrementDistributedBy(seedId, minted, txn);
		}
	}

	return affectedNftIds;
}
