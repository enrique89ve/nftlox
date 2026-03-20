import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getPackForProcessing,
	upsertPackBalance,
	getPackBalance,
	incrementPackOpened,
	insertPackHistoryEvent,
} from "@/db/queries/packs.ts";
import {
	insertNft,
	getSeedWithDna,
	nftExists,
	incrementDistributed,
} from "@/db/queries/nfts.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString, requireNumber } from "@/utils/validation.ts";
import {
	resolveDropTable,
	generateDeterministicInstanceId,
	generateOriginDnaSync,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
} from "nftlox-sdk";

export async function handlePackOpen(op: ParsedOperation, txn: Queryable): Promise<void> {
	const packId = requireString(op.data.packId, "packId");
	const quantity = requireNumber(op.data.quantity, "quantity");

	if (quantity < 1) throw new Error("Quantity must be positive");

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);

	// Pre-check balance before deduction (prevents raw Postgres CHECK violation)
	const currentBalance = await getPackBalance(op.signer, packId, txn);
	if (currentBalance < quantity) {
		throw new Error(
			`Insufficient pack balance: has ${currentBalance}, needs ${quantity}`,
		);
	}

	await upsertPackBalance(op.signer, packId, -quantity, txn);

	const mintedNfts: Array<{ instanceId: string; seedId: string; packIndex: number }> = [];

	for (let packIndex = 0; packIndex < quantity; packIndex++) {
		// Deterministic RNG seed using immutable block data
		const rngSeed = `${op.txId}:${op.blockNum}:${op.signer}:${packId}:${packIndex}`;
		const selectedSeeds = resolveDropTable(
			pack.drop_table,
			pack.items_per_pack,
			rngSeed,
		);

		for (let itemIndex = 0; itemIndex < selectedSeeds.length; itemIndex++) {
			const seedId = selectedSeeds[itemIndex]!;

			const seed = await getSeedWithDna(seedId, txn);
			if (!seed) continue; // Defensive: skip if seed disappeared

			const distributed = Number(seed.distributed) || 0;
			const maxReplicas = Number(seed.max_replicas) || 0;

			// Skip if max supply reached (defensive, should rarely happen)
			if (maxReplicas > 0 && distributed >= maxReplicas) continue;

			const instanceNumber = distributed + 1;
			const instanceId = generateDeterministicInstanceId(seedId, instanceNumber);

			// Skip if instance already exists (idempotency)
			if (await nftExists(instanceId, txn)) continue;

			// DNA Lineage: deterministic from immutable block data
			const originDna = seed.origin_dna
				?? generateOriginDnaSync(seed.collection_id);
			const instanceDna = generateDeterministicInstanceDna(
				seedId, instanceNumber, op.txId, op.blockNum,
			);
			const uniqueAccessKey = generateDeterministicAccessKey(
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
				name: seed.name ?? "",
				description: null,
				imageUrl: seed.image_url,
				imageHash: seed.image_hash,
				maxReplicas: 0,
				seedId,
				instanceNumber,
				originalId: null,
				tags: null,
				customData: { source: "pack", packId },
				blockNum: op.blockNum,
				txId: op.txId,
				createdAt: op.timestamp,
			}, txn);

			await incrementDistributed(seedId, txn);

			await insertHistoryEvent({
				nftId: instanceId,
				collectionId: seed.collection_id,
				eventType: "distribute",
				blockNum: op.blockNum,
				txId: op.txId,
				timestamp: op.timestamp,
				fromAccount: op.signer,
				toAccount: op.signer,
				priceAmount: null,
				priceCurrency: null,
				payload: { source: "pack_open", packId },
			}, txn);

			mintedNfts.push({ instanceId, seedId, packIndex });
		}
	}

	await incrementPackOpened(packId, quantity, txn);

	await insertPackHistoryEvent({
		packId,
		collectionId: pack.collection_id,
		eventType: "pack_open",
		blockNum: op.blockNum,
		txId: op.txId,
		timestamp: op.timestamp,
		fromAccount: op.signer,
		toAccount: null,
		quantity,
		priceAmount: null,
		priceCurrency: null,
		payload: { mintedNfts },
	}, txn);
}
