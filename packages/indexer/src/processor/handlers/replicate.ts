import type { Queryable } from "../../db/client.ts";
import type { ParsedOperation } from "../../scanner/operation-parser.ts";
import { insertNft, nftExists, getNftForProcessing } from "../../db/queries/nfts.ts";
import { insertHistoryEvent } from "../../db/queries/history.ts";
import { requireString, optionalString } from "../../utils/validation.ts";

export async function handleReplicate(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireString(d.id, "id");
	const originalId = requireString(d.originalId, "originalId");
	const newOwner = requireString(d.newOwner, "newOwner");

	if (await nftExists(id, txn)) throw new Error(`Replica already exists: ${id}`);
	const original = await getNftForProcessing(originalId, txn);
	if (!original) throw new Error(`Original NFT not found: ${originalId}`);
	if (original.status === "burned") throw new Error(`Original NFT is burned: ${originalId}`);

	await insertNft({
		id, collectionId: original.collection_id, nftType: "replica", edition: 1,
		owner: newOwner, originDna: optionalString(d.originDna),
		instanceDna: optionalString(d.instanceDna), uniqueAccessKey: optionalString(d.uniqueAccessKey),
		birthBlock: op.blockNum, birthTx: op.txId, mintedBy: op.signer,
		name: optionalString(d.name) ?? `${original.name} (Replica)`,
		description: null, imageUrl: null, imageHash: null,
		maxReplicas: 0, seedId: null, instanceNumber: null, originalId,
		tags: null, customData: null,
		blockNum: op.blockNum, txId: op.txId, createdAt: op.timestamp,
	}, txn);

	await insertHistoryEvent({
		nftId: id, collectionId: original.collection_id, eventType: "replicate",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: newOwner,
		priceAmount: null, priceCurrency: null, payload: op.data,
	}, txn);
}
