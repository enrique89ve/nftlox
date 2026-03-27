import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	insertNft,
	nftExists,
	getSeedWithDna,
	incrementDistributedBy,
	NFT_STATUS_BURNED,
	NFT_STATUS_LENT,
} from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { requireString, requireNumber, requireArray, optionalString } from "@/utils/validation.ts";
import {
	generateDeterministicInstanceId,
	generateOriginDnaSync,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
	MAX_BULK_DISTRIBUTE_ITEMS,
	validateHiveUsername,
	ACTION_BULK_DISTRIBUTE,
	computeDataHashSync,
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
	const imageOverrides = (op.data.imageOverrides as Record<string, { imageUrl?: string; imageHash?: string }>) ?? {};
	const customData = (op.data.data as Record<string, unknown>) ?? null;
	const mutableData = (op.data.mutableData as Record<string, unknown>) ?? null;

	// Validate mutableData against schema if collection has one
	if (mutableData) {
		// We need to check at least one seed's collection for schema
		// Validation happens per-seed below after collection is fetched
	}
	const mutableDataHash = mutableData ? computeDataHashSync(mutableData) : null;

	if (items.length === 0) throw new Error("Items array is empty");
	if (items.length > MAX_BULK_DISTRIBUTE_ITEMS) {
		throw new Error(`Too many distinct seeds: ${items.length} exceeds max ${MAX_BULK_DISTRIBUTE_ITEMS}`);
	}

	let totalQuantity = 0;
	const parsedItems: Array<{ seedId: string; quantity: number }> = [];
	const seenSeeds = new Set<string>();

	for (const item of items) {
		const raw = item as Record<string, unknown>;
		const seedId = requireString(raw.seedId, "seedId");
		const quantity = requireNumber(raw.quantity, "quantity");
		if (quantity < 1) throw new Error(`Invalid quantity for seed ${seedId}`);
		if (seenSeeds.has(seedId)) throw new Error(`Duplicate seedId in items: ${seedId}`);
		seenSeeds.add(seedId);
		totalQuantity += quantity;
		parsedItems.push({ seedId, quantity });
	}

	// Cache collection creators to avoid repeated queries
	const collectionCreators = new Map<string, string>();

	for (const { seedId, quantity } of parsedItems) {
		const seed = await getSeedWithDna(seedId, txn);
		if (!seed) throw new Error(`Seed not found: ${seedId}`);
		if (seed.status === NFT_STATUS_BURNED) throw new Error(`Seed is burned: ${seedId}`);
		if (seed.status === NFT_STATUS_LENT) throw new Error(`Seed is lent: ${seedId}`);
		if (seed.nft_type !== "seed") throw new Error(`${seedId} is not a seed`);

		// Permission: seed owner OR collection creator
		const isOwner = seed.owner === op.signer;
		let collectionRules = collectionCreators.get(seed.collection_id);
		if (collectionRules === undefined) {
			const rules = await getCollectionRules(seed.collection_id, txn);
			collectionCreators.set(seed.collection_id, rules?.creator ?? "");
			// Validate mutableData against schema (once per collection)
			const schema = rules?.schema as CollectionSchema | null;
			if (schema && mutableData) {
				const errors = validateMutableUpdate(schema, mutableData);
				if (errors.length > 0) {
					const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
					throw new Error(`Schema validation failed for bulk_distribute mutableData: ${messages}`);
				}
			}
		}
		if (!isOwner) {
			const creator = collectionCreators.get(seed.collection_id);
			if (creator !== op.signer) {
				throw new Error(`Signer ${op.signer} is not owner of seed ${seedId} nor creator of collection ${seed.collection_id}`);
			}
		}

		const distributed = Number(seed.distributed) || 0;
		const maxReplicas = Number(seed.max_replicas) || 0;

		// Idempotency: count instances already created by THIS transaction.
		// On replay, `distributed` reflects prior runs. Subtracting instances
		// born from the same txId recovers the pre-tx baseline so instance
		// numbers remain deterministic across replays.
		const [existingFromTx] = await txn`
			SELECT COUNT(*)::int AS count FROM nfts
			WHERE seed_id = ${seedId} AND birth_tx = ${op.txId}
		`;
		const alreadyMintedThisTx = existingFromTx?.count ?? 0;
		const baseDistributed = distributed - alreadyMintedThisTx;

		if (maxReplicas > 0 && baseDistributed + quantity > maxReplicas) {
			throw new Error(
				`Seed ${seedId} insufficient supply: needs ${quantity}, available ${maxReplicas - baseDistributed}`,
			);
		}

		const originDna = seed.origin_dna
			?? generateOriginDnaSync(seed.collection_id);
		const override = imageOverrides[seedId];

		let minted = 0;

		for (let i = 0; i < quantity; i++) {
			const instanceNumber = baseDistributed + i + 1;
			const instanceId = generateDeterministicInstanceId(seedId, instanceNumber);

			if (await nftExists(instanceId, txn)) continue;

			const instanceDna = generateDeterministicInstanceDna(
				seedId, instanceNumber, op.txId, op.blockNum,
			);
			const uniqueAccessKey = generateDeterministicAccessKey(
				instanceDna, op.signer, op.txId,
			);

			// Inherit immutable_data from seed
			const seedImmutableData = seed.immutable_data as Record<string, unknown> | null;

			await insertNft({
				id: instanceId,
				collectionId: seed.collection_id,
				nftType: "instance",
				edition: 1,
				owner: to,
				originDna,
				instanceDna,
				uniqueAccessKey,
				birthBlock: op.blockNum,
				birthTx: op.txId,
				mintedBy: op.signer,
				name: seed.name ?? "",
				description: null,
				imageUrl: override?.imageUrl ?? seed.image_url ?? null,
				imageHash: override?.imageHash ?? seed.image_hash ?? null,
				maxReplicas: 0,
				seedId,
				instanceNumber,
				originalId: null,
				tags: null,
				customData: mutableData ? null : { source: ACTION_BULK_DISTRIBUTE, ...(customData ?? {}) },
				immutableData: seedImmutableData,
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
