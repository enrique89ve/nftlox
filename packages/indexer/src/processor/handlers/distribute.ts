import type { Queryable } from "../../db/client.ts";
import type { ParsedOperation } from "../../scanner/operation-parser.ts";
import { insertNft, nftExists, getNftForProcessing, incrementDistributed } from "../../db/queries/nfts.ts";
import { insertHistoryEvent } from "../../db/queries/history.ts";
import { requireString, optionalString, optionalNumber, optionalStringArray } from "../../utils/validation.ts";

export async function handleDistribute(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const seedId = requireString(d.seedId, "seedId");
	const instanceId = requireString(d.instanceId, "instanceId");
	const to = requireString(d.to, "to");
	const instanceNumber = optionalNumber(d.instanceNumber);

	if (await nftExists(instanceId, txn)) throw new Error(`Instance already exists: ${instanceId}`);

	const seed = await getNftForProcessing(seedId, txn);
	if (!seed) throw new Error(`Seed not found: ${seedId}`);
	if (seed.nft_type !== "seed") throw new Error(`${seedId} is not a seed`);
	if (seed.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of seed ${seedId}`);

	const distributed = Number(seed.distributed) || 0;
	const maxReplicas = Number(seed.max_replicas) || 0;
	if (maxReplicas > 0 && distributed >= maxReplicas) {
		throw new Error(`Seed ${seedId} max supply reached (${distributed}/${maxReplicas})`);
	}

	await insertNft({
		id: instanceId, collectionId: seed.collection_id, nftType: "instance",
		edition: optionalNumber(d.edition) ?? 1, owner: to,
		originDna: optionalString(d.originDna), instanceDna: optionalString(d.instanceDna),
		uniqueAccessKey: optionalString(d.uniqueAccessKey),
		birthBlock: op.blockNum, birthTx: op.txId, mintedBy: op.signer,
		name: optionalString(d.name) ?? seed.name ?? "",
		description: null, imageUrl: optionalString(d.imageUrl), imageHash: optionalString(d.imageHash),
		maxReplicas: 0, seedId, instanceNumber: instanceNumber ?? null, originalId: null,
		tags: optionalStringArray(d.tags), customData: d.data ?? null,
		blockNum: op.blockNum, txId: op.txId, createdAt: op.timestamp,
	}, txn);

	await incrementDistributed(seedId, txn);

	await insertHistoryEvent({
		nftId: instanceId, collectionId: seed.collection_id, eventType: "distribute",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: to,
		priceAmount: null, priceCurrency: null, payload: op.data,
	}, txn);
}
