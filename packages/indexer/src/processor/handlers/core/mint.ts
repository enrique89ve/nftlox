import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { insertNft, nftExists } from "@/db/queries/nfts.ts";
import { requireString, optionalString, optionalNumber, optionalObject, optionalStringArray } from "@/utils/validation.ts";

export async function handleMint(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireString(d.id, "id");
	const collectionId = requireString(d.collectionId, "collectionId");

	if (await nftExists(id, txn)) throw new Error(`NFT already exists: ${id}`);
	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) throw new Error(`Only the collection creator can mint in ${collectionId}`);

	const metadata = optionalObject(d.metadata) ?? {};
	const isSeed = id.startsWith("seed_");

	await insertNft({
		id, collectionId, nftType: isSeed ? "seed" : "instance",
		edition: optionalNumber(d.edition) ?? 1,
		owner: optionalString(d.owner) ?? op.signer,
		originDna: optionalString(d.originDna),
		instanceDna: optionalString(d.instanceDna),
		uniqueAccessKey: optionalString(d.uniqueAccessKey),
		birthBlock: op.blockNum,
		birthTx: op.txId,
		mintedBy: op.signer,
		name: optionalString(metadata.name) ?? optionalString(d.name) ?? "",
		description: optionalString(metadata.description),
		imageUrl: optionalString(metadata.imageUrl),
		imageHash: optionalString(metadata.imageHash),
		maxReplicas: optionalNumber(d.maxReplicas) ?? 1,
		seedId: null, instanceNumber: null, originalId: null,
		tags: optionalStringArray(d.tags), customData: d.data ?? null,
		blockNum: op.blockNum, txId: op.txId, createdAt: op.timestamp,
	}, txn);
}
