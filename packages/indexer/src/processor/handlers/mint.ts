import type { Queryable } from "../../db/client.ts";
import type { ParsedOperation } from "../../scanner/operation-parser.ts";
import { collectionExists } from "../../db/queries/collections.ts";
import { insertNft, nftExists } from "../../db/queries/nfts.ts";
import { insertHistoryEvent } from "../../db/queries/history.ts";
import { requireString, optionalString, optionalNumber, optionalObject, optionalStringArray } from "../../utils/validation.ts";

export async function handleMint(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireString(d.id, "id");
	const collectionId = requireString(d.collectionId, "collectionId");

	if (await nftExists(id, txn)) throw new Error(`NFT already exists: ${id}`);
	if (!(await collectionExists(collectionId, txn))) throw new Error(`Collection not found: ${collectionId}`);

	const metadata = optionalObject(d.metadata) ?? {};
	const isSeed = id.startsWith("seed_");

	await insertNft({
		id, collectionId, nftType: isSeed ? "seed" : "instance",
		edition: optionalNumber(d.edition) ?? 1,
		owner: optionalString(d.owner) ?? op.signer,
		originDna: optionalString(d.originDna),
		instanceDna: optionalString(d.instanceDna),
		uniqueAccessKey: optionalString(d.uniqueAccessKey),
		birthBlock: optionalNumber(d.birthBlock) ?? op.blockNum,
		birthTx: optionalString(d.birthTx) ?? op.txId,
		mintedBy: optionalString(d.mintedBy) ?? op.signer,
		name: optionalString(metadata.name) ?? optionalString(d.name) ?? "",
		description: optionalString(metadata.description),
		imageUrl: optionalString(metadata.imageUrl),
		imageHash: optionalString(metadata.imageHash),
		maxReplicas: optionalNumber(d.maxReplicas) ?? 1,
		seedId: null, instanceNumber: null, originalId: null,
		tags: optionalStringArray(d.tags), customData: d.data ?? null,
		blockNum: op.blockNum, txId: op.txId, createdAt: op.timestamp,
	}, txn);

	await insertHistoryEvent({
		nftId: id, collectionId, eventType: "mint",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: null, toAccount: optionalString(d.owner) ?? op.signer,
		priceAmount: null, priceCurrency: null, payload: op.data,
	}, txn);
}
