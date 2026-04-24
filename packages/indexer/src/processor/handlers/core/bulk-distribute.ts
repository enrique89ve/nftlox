import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	insertNft,
	nftExists,
	isBurnedId,
	getSeedWithSchemaForUpdate,
	incrementDistributedBy,
} from "@/db/queries/nfts.ts";
import { countInstancesByCollection, countInstancesByCreator } from "@/db/queries/collections.ts";
import { assertWithinLimit } from "@/utils/action-limits.ts";
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
	generateInstanceDna,
	ACTION_BULK_DISTRIBUTE,
	MAX_BULK_DISTRIBUTE_ITEMS,
	MAX_BULK_DISTRIBUTE_TOTAL_QUANTITY,
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
	const seenSeeds = new Set<string>();
	let totalQuantity = 0;

	for (const item of items) {
		const raw = requireObject(item, "items[]");
		const seedId = requireString(raw.seedId, "seedId");
		const quantity = requirePositiveInt(raw.quantity, "quantity");
		const seedTxId = requireString(raw.seedTxId, "seedTxId");
		totalQuantity += quantity;
		if (seenSeeds.has(seedId)) throw new Error(`Duplicate seedId in items: ${seedId}`);
		seenSeeds.add(seedId);
		parsedItems.push({ seedId, quantity, seedTxId });
	}

	if (totalQuantity > MAX_BULK_DISTRIBUTE_TOTAL_QUANTITY) {
		throw new Error(
			`Too many instances: ${totalQuantity} exceeds max ${MAX_BULK_DISTRIBUTE_TOTAL_QUANTITY}`,
		);
	}

	// Track validated schemas to avoid re-validating mutableData per collection
	const validatedSchemas = new Set<string>();

	// Per-creator instance budget. Lazily fetched on first sight; planned
	// quantity is accumulated across items so the limit is enforced against the
	// aggregate even when one bulk_distribute spans multiple seeds (or multiple
	// collections from different creators if the signer owns transferred seeds).
	const creatorInstanceBudget = new Map<string, { baseline: number; planned: number }>();

	// Per-collection instance budget. When `collections.max_instances > 0` the
	// declared cap is enforced; 0 means unlimited (creator opted out at
	// creation time). Baseline is the materialized `collection_stats.instances`
	// — `planned` accumulates across items in this op so a single
	// bulk_distribute targeting multiple seeds in the same collection cannot
	// breach the cap by splitting the request.
	const collectionInstanceBudget = new Map<string, { baseline: number; planned: number; cap: number }>();

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

		let budget = creatorInstanceBudget.get(seed.creator);
		if (!budget) {
			budget = { baseline: await countInstancesByCreator(seed.creator, txn), planned: 0 };
			creatorInstanceBudget.set(seed.creator, budget);
		}
		budget.planned += quantity;
		await assertWithinLimit("instancesPerCreator", seed.creator, budget.baseline, budget.planned);

		// Per-collection cap: enforce only when the creator declared one
		// (max_instances > 0). The seed row already carries the cap, so no
		// extra collections-table read is needed here.
		if (seed.max_instances > 0) {
			let collectionBudget = collectionInstanceBudget.get(seed.collection_id);
			if (!collectionBudget) {
				collectionBudget = {
					baseline: await countInstancesByCollection(seed.collection_id, txn),
					planned: 0,
					cap: seed.max_instances,
				};
				collectionInstanceBudget.set(seed.collection_id, collectionBudget);
			}
			collectionBudget.planned += quantity;
			if (collectionBudget.baseline + collectionBudget.planned > collectionBudget.cap) {
				throw new Error(
					`bulk_distribute exceeds collection cap: collection ${seed.collection_id} ` +
						`would reach ${collectionBudget.baseline + collectionBudget.planned} ` +
						`instances, max_instances=${collectionBudget.cap}`,
				);
			}
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
		const maxSupply = Number(seed.max_supply) || 0;

		// Idempotency: count instances already created by THIS operation.
		const [existingFromOp] = await txn`
			SELECT COUNT(*)::int AS count FROM nfts
			WHERE seed_id = ${seedId}
				AND created_operation_id = ${op.operationId}
		`;
		const alreadyMintedThisOp = existingFromOp?.count ?? 0;
		const baseDistributed = computeInstanceBaseline(distributed, alreadyMintedThisOp);

		const reservedSupply = Number(seed.reserved_supply) || 0;
		validateSeedSupplyForDistribution(seedId, maxSupply, baseDistributed, quantity, reservedSupply);

		let minted = 0;

		for (let i = 0; i < quantity; i++) {
			const instanceNumber = baseDistributed + i + 1;
			const instanceId = await generateDeterministicInstanceId(seedId, instanceNumber);

			if (await nftExists(instanceId, txn)) continue;

			// Defense-in-depth against resurrection of a burned instance. The
			// `distributed` counter is monotonic so this branch is unreachable in
			// normal flow (burning an instance never rewinds distributed). It
			// matters under pathological scenarios: a reorg that rewinds state
			// below a prior burn, or a future code change that decrements
			// distributed. Cheap O(1) check — always worth paying.
			if (await isBurnedId(instanceId, txn)) {
				throw new Error(
					`bulk_distribute rejected: instance id ${instanceId} was previously burned`,
				);
			}

			const nftDna = await generateInstanceDna(
				seedId, instanceNumber, op.txId, op.blockNum,
			);

			// Instance stores only references; name, image, and origin_dna are
			// inherited via JOIN at query time (seed→collection chain).
			await insertNft({
				id: instanceId,
				collectionId: seed.collection_id,
				nftType: "instance",
				edition: 1,
				owner: to,
				nftDna,
				name: "",
				imageUrl: null,
				maxSupply: 0,
				seedId,
				instanceNumber,
				artId: null,
				immutableData: null,
				dataOperationId: mutableData ? op.operationId : null,
				dataHash,
				schemaVersion: seed.schema_version,
				ownerOperationId: op.operationId,
				ownerAction: ACTION_BULK_DISTRIBUTE,
				ownerBlockNum: op.blockNum,
				createdOperationId: op.operationId,
				createdBlockNum: op.blockNum,
				createdTxId: op.txId,
				createdAt: op.timestamp,
			}, txn);

			minted++;
		}

		if (minted > 0) {
			await incrementDistributedBy(seedId, minted, txn);
		}
	}

	return [];
}
