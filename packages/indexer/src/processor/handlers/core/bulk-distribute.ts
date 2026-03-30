import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	insertNft,
	nftExists,
	getSeedWithSchema,
	incrementDistributedBy,
} from "@/db/queries/nfts.ts";
import { assertNotBurned, assertNotLent } from "@/utils/status-checks.ts";
import { requireString, requireNumber, requireArray, optionalString, optionalObject } from "@/utils/validation.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { computeInstanceBaseline, validateSeedSupplyForDistribution } from "@/utils/nft-rules.ts";
import {
	generateDeterministicInstanceId,
	generateOriginDna,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
	MAX_BULK_DISTRIBUTE_ITEMS,
	validateHiveUsername,
	computeDataHash,
	validateMutableUpdate,
	type CollectionSchema,
} from "nftlox-sdk";

export async function handleBulkDistribute(op: ParsedOperation, txn: Queryable): Promise<void> {
	const toRaw = optionalString(op.data.to);
	if (toRaw) {
		const error = validateHiveUsername(toRaw);
		if (error) throw new Error(`Invalid Hive username for to ("${toRaw}"): ${error}`);
	}
	const to = toRaw ?? op.signer;
	const items = requireArray(op.data.items, "items");
	const imageOverrides = (optionalObject(op.data.imageOverrides) ?? {}) as Record<string, { imageUrl?: string; imageHash?: string }>;
	const mutableData = optionalObject(op.data.mutableData) as Record<string, unknown> | null;

	const mutableDataHash = mutableData ? await computeDataHash(mutableData) : null;

	if (items.length === 0) throw new Error("Items array is empty");
	if (items.length > MAX_BULK_DISTRIBUTE_ITEMS) {
		throw new Error(`Too many distinct seeds: ${items.length} exceeds max ${MAX_BULK_DISTRIBUTE_ITEMS}`);
	}

	let totalQuantity = 0;
	const parsedItems: Array<{ seedId: string; quantity: number; seedTxId: string }> = [];
	const seenSeeds = new Set<string>();

	for (const item of items) {
		const raw = item as Record<string, unknown>;
		const seedId = requireString(raw.seedId, "seedId");
		const quantity = requireNumber(raw.quantity, "quantity");
		const seedTxId = requireString(raw.seedTxId, "seedTxId");
		if (quantity < 1) throw new Error(`Invalid quantity for seed ${seedId}`);
		if (seenSeeds.has(seedId)) throw new Error(`Duplicate seedId in items: ${seedId}`);
		seenSeeds.add(seedId);
		totalQuantity += quantity;
		parsedItems.push({ seedId, quantity, seedTxId });
	}

	// Track validated schemas to avoid re-validating mutableData per collection
	const validatedSchemas = new Set<string>();

	for (const { seedId, quantity, seedTxId } of parsedItems) {
		const seed = await getSeedWithSchema(seedId, txn);
		if (!seed) throw new Error(`Seed not found: ${seedId}`);
		assertNotBurned(seed, seedId);
		assertNotLent(seed, seedId);
		if (seed.nft_type !== "seed") throw new Error(`${seedId} is not a seed`);
		if (seed.tx_id !== seedTxId) {
			throw new Error(`seedTxId mismatch for seed ${seedId}`);
		}

		const isOwner = seed.owner === op.signer;
		const isCreator = seed.creator === op.signer;
		if (!isOwner && !isCreator) {
			throw new Error(`Signer ${op.signer} is neither owner nor collection creator of seed ${seedId}`);
		}

		if (!validatedSchemas.has(seed.collection_id)) {
			validatedSchemas.add(seed.collection_id);
			const schema = seed.schema as CollectionSchema | null;
			if (schema && mutableData) {
				const errors = validateMutableUpdate(schema, mutableData);
				if (errors.length > 0) {
					throw new Error(`Schema validation failed for bulk_distribute mutableData: ${formatSchemaErrors(errors)}`);
				}
			}
		}

		const distributed = Number(seed.distributed) || 0;
		const maxReplicas = Number(seed.max_replicas) || 0;

		// Idempotency: count instances already created by THIS Hive transaction.
		// Multiple instances share the same tx_id (Hive txIds are per-transaction,
		// not per-operation). On replay, `distributed` reflects prior runs.
		// Subtracting instances from the same txId recovers the pre-tx baseline
		// so instance numbers remain deterministic across replays.
		const [existingFromTx] = await txn`
			SELECT COUNT(*)::int AS count FROM nfts
			WHERE seed_id = ${seedId} AND tx_id = ${op.txId}
		`;
		const alreadyMintedThisTx = existingFromTx?.count ?? 0;
		const baseDistributed = computeInstanceBaseline(distributed, alreadyMintedThisTx);

		validateSeedSupplyForDistribution(seedId, maxReplicas, baseDistributed, quantity);

		const originDna = seed.origin_dna
			?? await generateOriginDna(seed.collection_id);
		const override = imageOverrides[seedId];

		let minted = 0;

		for (let i = 0; i < quantity; i++) {
			const instanceNumber = baseDistributed + i + 1;
			const instanceId = await generateDeterministicInstanceId(seedId, instanceNumber);

			if (await nftExists(instanceId, txn)) continue;

			const instanceDna = await generateDeterministicInstanceDna(
				seedId, instanceNumber, op.txId, op.blockNum,
			);
			const uniqueAccessKey = await generateDeterministicAccessKey(
				instanceDna, op.signer, op.txId,
			);

			// Instance stores only its own data; name, image, immutable_data
			// are inherited from seed via JOIN at query time.
			await insertNft({
				id: instanceId,
				collectionId: seed.collection_id,
				nftType: "instance",
				edition: 1,
				owner: to,
				originDna,
				instanceDna,
				uniqueAccessKey,
				mintedBy: op.signer,
				name: "",
				description: null,
				imageUrl: override?.imageUrl ?? null,
				imageHash: override?.imageHash ?? null,
				maxReplicas: 0,
				seedId,
				instanceNumber,
				originalId: null,
				immutableData: null,
				immutableDataHash: null,
				mutableData,
				mutableDataHash,
				blockNum: op.blockNum,
				txId: op.txId,
				createdAt: op.timestamp,
			}, txn);

			minted++;
		}

		if (minted > 0) {
			await incrementDistributedBy(seedId, minted, txn);
		}
	}
}
