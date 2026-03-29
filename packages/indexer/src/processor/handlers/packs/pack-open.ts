import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getPackForProcessing,
	upsertPackBalance,
	getPackBalance,
	incrementPackOpened,
} from "@/db/queries/packs.ts";
import {
	insertNft,
	getSeedWithDna,
	nftExists,
	incrementDistributed,
} from "@/db/queries/nfts.ts";
import { requireString, requireNumber } from "@/utils/validation.ts";
import {
	resolveDropTable,
	generateDeterministicInstanceId,
	generateOriginDna,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
	computeDataHash,
	MAX_PACK_OPEN_BATCH,
} from "nftlox-sdk";

export async function handlePackOpen(op: ParsedOperation, txn: Queryable): Promise<void> {
	const packId = requireString(op.data.packId, "packId");
	const quantity = requireNumber(op.data.quantity, "quantity");

	if (quantity < 1) throw new Error("Quantity must be positive");
	if (quantity > MAX_PACK_OPEN_BATCH) {
		throw new Error(`Cannot open more than ${MAX_PACK_OPEN_BATCH} packs at once, got ${quantity}`);
	}

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);

	// Parse drop_table BEFORE any state mutations to fail fast on corrupted data
	let dropTable: unknown;
	try {
		dropTable = typeof pack.drop_table === "string"
			? JSON.parse(pack.drop_table) : pack.drop_table;
	} catch {
		throw new Error(`Pack ${packId} has corrupted drop_table`);
	}
	if (!Array.isArray(dropTable) || dropTable.length === 0) {
		throw new Error(`Pack ${packId} has empty or invalid drop_table`);
	}

	// Pre-check balance before deduction (prevents raw Postgres CHECK violation)
	const currentBalance = await getPackBalance(op.signer, packId, txn);
	if (currentBalance < quantity) {
		throw new Error(
			`Insufficient pack balance: has ${currentBalance}, needs ${quantity}`,
		);
	}

	await upsertPackBalance(op.signer, packId, -quantity, txn);

	// Balance tracker: tracks how many instances we've minted per seed
	// within THIS handler invocation, so the same seed appearing multiple
	// times in the drop table gets sequential instance numbers.
	const localMintedPerSeed = new Map<string, number>();

	for (let packIndex = 0; packIndex < quantity; packIndex++) {
		// Deterministic RNG seed using immutable block data
		const rngSeed = `${op.txId}:${op.blockNum}:${op.signer}:${packId}:${packIndex}`;
		const selectedSeeds = resolveDropTable(
			dropTable as Array<{ seedId: string; weight: number }>,
			pack.items_per_pack,
			rngSeed,
		);

		for (let itemIndex = 0; itemIndex < selectedSeeds.length; itemIndex++) {
			const seedId = selectedSeeds[itemIndex]!;

			const seed = await getSeedWithDna(seedId, txn);
			if (!seed) throw new Error(`Seed ${seedId} not found during pack opening (pack: ${packId})`);

			const distributed = Number(seed.distributed) || 0;
			const maxReplicas = Number(seed.max_replicas) || 0;

			// Idempotency: recover pre-tx baseline by subtracting instances
			// already created by this exact transaction
			const [existingFromTx] = await txn`
				SELECT COUNT(*)::int AS count FROM nfts
				WHERE seed_id = ${seedId} AND birth_tx = ${op.txId}
			`;
			const alreadyMintedThisTx = existingFromTx?.count ?? 0;
			const baseDistributed = distributed - alreadyMintedThisTx;

			// Local offset for same seed appearing multiple times in this invocation
			const localOffset = localMintedPerSeed.get(seedId) ?? 0;
			const instanceNumber = baseDistributed + localOffset + 1;

			// Skip if max supply reached
			if (maxReplicas > 0 && instanceNumber > maxReplicas) continue;

			const instanceId = await generateDeterministicInstanceId(seedId, instanceNumber);

			// Skip if instance already exists (idempotency)
			if (await nftExists(instanceId, txn)) {
				localMintedPerSeed.set(seedId, localOffset + 1);
				continue;
			}

			// DNA Lineage: deterministic from immutable block data
			const originDna = seed.origin_dna
				?? await generateOriginDna(seed.collection_id);
			const instanceDna = await generateDeterministicInstanceDna(
				seedId, instanceNumber, op.txId, op.blockNum,
			);
			const uniqueAccessKey = await generateDeterministicAccessKey(
				instanceDna, op.signer, op.txId,
			);

			await insertNft({
				id: instanceId,
				collectionId: seed.collection_id,
				nftType: "instance",
				edition: 1,
				owner: op.signer,
				originDna,
				instanceDna,
				uniqueAccessKey,
				birthBlock: op.blockNum,
				birthTx: op.txId,
				mintedBy: op.signer,
				name: "",
				description: null,
				imageUrl: null,
				imageHash: null,
				maxReplicas: 0,
				seedId,
				instanceNumber,
				originalId: null,
				immutableData: null,
				immutableDataHash: null,
				mutableData: null,
				mutableDataHash: null,
				blockNum: op.blockNum,
				txId: op.txId,
				createdAt: op.timestamp,
			}, txn);

			await incrementDistributed(seedId, txn);
			localMintedPerSeed.set(seedId, localOffset + 1);
		}
	}

	await incrementPackOpened(packId, quantity, txn);
}
