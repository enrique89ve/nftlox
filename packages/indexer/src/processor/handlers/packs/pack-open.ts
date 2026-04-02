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
	getSeedWithDnaForUpdate,
	nftExists,
	incrementDistributed,
	type SeedWithDnaRow,
} from "@/db/queries/nfts.ts";
import { requireString, requireNumber } from "@/utils/validation.ts";
import { assertActionable } from "@/utils/status-checks.ts";
import { computeInstanceBaseline } from "@/utils/nft-rules.ts";
import {
	resolveDropTable,
	generateDeterministicInstanceId,
	generateOriginDna,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
	MAX_PACK_OPEN_BATCH,
} from "nftlox-sdk";

// ============ TYPES ============

type DropEntry = { readonly seedId: string; readonly weight: number };

type MintPlanItem = {
	readonly seedId: string;
	readonly seed: SeedWithDnaRow;
	readonly instanceNumber: number;
};

// ============ DROP TABLE VALIDATION ============

function parseDropTable(raw: unknown, packId: string): ReadonlyArray<DropEntry> {
	const parsed = typeof raw === "string" ? tryParseJson(raw) : raw;
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(`Pack ${packId} has empty or invalid drop_table`);
	}
	for (const entry of parsed) {
		if (
			typeof entry !== "object" || entry === null ||
			typeof entry.seedId !== "string" ||
			typeof entry.weight !== "number"
		) {
			throw new Error(`Pack ${packId} has corrupted drop_table entry`);
		}
	}
	return parsed as ReadonlyArray<DropEntry>;
}

function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// ============ SUPPLY VALIDATION (Phase 1) ============

async function buildMintPlan(
	selectedSeeds: ReadonlyArray<string>,
	packId: string,
	txId: string,
	localMintedPerSeed: ReadonlyMap<string, number>,
	txn: Queryable,
): Promise<ReadonlyArray<MintPlanItem> | null> {
	const plan: MintPlanItem[] = [];
	const packOffsets = new Map<string, number>();

	for (const seedId of selectedSeeds) {
		const seed = await getSeedWithDnaForUpdate(seedId, txn);
		if (!seed) throw new Error(`Seed ${seedId} not found during pack opening (pack: ${packId})`);
		assertActionable(seed, seedId);

		const maxReplicas = Number(seed.max_replicas) || 0;
		const distributed = Number(seed.distributed) || 0;

		// Idempotency: multiple instances share the same tx_id (Hive txId is per-transaction)
		const [existingFromTx] = await txn`
			SELECT COUNT(*)::int AS count FROM nfts
			WHERE seed_id = ${seedId} AND tx_id = ${txId}
		`;
		const baseDistributed = computeInstanceBaseline(distributed, existingFromTx?.count ?? 0);

		const globalOffset = localMintedPerSeed.get(seedId) ?? 0;
		const packOffset = packOffsets.get(seedId) ?? 0;
		const instanceNumber = baseDistributed + globalOffset + packOffset + 1;

		if (maxReplicas > 0 && instanceNumber > maxReplicas) {
			return null; // supply exhausted — entire pack cannot deliver
		}

		packOffsets.set(seedId, packOffset + 1);
		plan.push({ seedId, seed, instanceNumber });
	}

	return plan;
}

// ============ MINT EXECUTION (Phase 2) ============

async function executeMintPlan(
	plan: ReadonlyArray<MintPlanItem>,
	op: ParsedOperation,
	localMintedPerSeed: Map<string, number>,
	txn: Queryable,
): Promise<void> {
	for (const item of plan) {
		const instanceId = await generateDeterministicInstanceId(item.seedId, item.instanceNumber);

		if (await nftExists(instanceId, txn)) {
			localMintedPerSeed.set(item.seedId, (localMintedPerSeed.get(item.seedId) ?? 0) + 1);
			continue;
		}

		const originDna = item.seed.origin_dna
			?? await generateOriginDna(item.seed.collection_id);
		const instanceDna = await generateDeterministicInstanceDna(
			item.seedId, item.instanceNumber, op.txId, op.blockNum,
		);
		const uniqueAccessKey = await generateDeterministicAccessKey(
			instanceDna, op.signer, op.txId,
		);

		await insertNft({
			id: instanceId,
			collectionId: item.seed.collection_id,
			nftType: "instance",
			edition: 1,
			owner: op.signer,
			originDna,
			instanceDna,
			uniqueAccessKey,
			mintedBy: op.signer,
			name: "",
			description: null,
			imageUrl: null,
			imageHash: null,
			maxReplicas: 0,
			seedId: item.seedId,
			instanceNumber: item.instanceNumber,
			originalId: null,
			immutableData: null,
			immutableDataHash: null,
			mutableData: null,
			mutableDataHash: null,
			schemaVersion: item.seed.schema_version,
			blockNum: op.blockNum,
			txId: op.txId,
			createdAt: op.timestamp,
		}, txn);

		await incrementDistributed(item.seedId, txn);
		localMintedPerSeed.set(item.seedId, (localMintedPerSeed.get(item.seedId) ?? 0) + 1);
	}
}

// ============ HANDLER ============

export async function handlePackOpen(op: ParsedOperation, txn: Queryable): Promise<void> {
	const packId = requireString(op.data.packId, "packId");
	const quantity = requireNumber(op.data.quantity, "quantity");

	if (quantity < 1) throw new Error("Quantity must be positive");
	if (quantity > MAX_PACK_OPEN_BATCH) {
		throw new Error(`Cannot open more than ${MAX_PACK_OPEN_BATCH} packs at once, got ${quantity}`);
	}

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);

	const dropTable = parseDropTable(pack.drop_table, packId);

	const currentBalance = await getPackBalance(op.signer, packId, txn);
	if (currentBalance < quantity) {
		throw new Error(`Insufficient pack balance: has ${currentBalance}, needs ${quantity}`);
	}

	let deliveredPacks = 0;
	const localMintedPerSeed = new Map<string, number>();

	for (let packIndex = 0; packIndex < quantity; packIndex++) {
		const rngSeed = `${op.txId}:${op.blockNum}:${op.signer}:${packId}:${packIndex}`;
		const selectedSeeds = resolveDropTable(
			dropTable as Array<DropEntry>,
			pack.items_per_pack,
			rngSeed,
		);

		const mintPlan = await buildMintPlan(selectedSeeds, packId, op.txId, localMintedPerSeed, txn);
		if (!mintPlan) continue;

		await executeMintPlan(mintPlan, op, localMintedPerSeed, txn);
		deliveredPacks++;
	}

	if (deliveredPacks === 0) {
		throw new Error(`No packs could be delivered for ${packId}: all seeds exhausted`);
	}

	await upsertPackBalance(op.signer, packId, -deliveredPacks, txn);
	await incrementPackOpened(packId, deliveredPacks, txn);
}
