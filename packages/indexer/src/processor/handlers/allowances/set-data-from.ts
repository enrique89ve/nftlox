import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getNftForProcessing,
	updateNftMutableData,
	NFT_STATUS_BURNED,
} from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { hasDataOperatorApproval } from "@/db/queries/allowances.ts";
import { requireString, optionalObject } from "@/utils/validation.ts";
import { validateMutableUpdate, computeDataHashSync, type CollectionSchema } from "nftlox-sdk";

export async function handleSetDataFrom(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const instanceDna = requireString(op.data.instanceDna, "instanceDna");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.instance_dna !== instanceDna) throw new Error(`Instance DNA mismatch for ${nftId}`);

	const isOperator = await hasDataOperatorApproval(nft.collection_id, op.signer, txn);
	if (!isOperator) {
		throw new Error(`Signer ${op.signer} is not an approved data operator for collection ${nft.collection_id}`);
	}

	const collection = await getCollectionRules(nft.collection_id, txn);
	const schema = collection?.schema as CollectionSchema | null;

	if (schema) {
		// Schema-based: operator writes to mutable_data (same field as creator)
		const mutableData = optionalObject(op.data.mutableData) as Record<string, unknown> | null;
		if (!mutableData || Object.keys(mutableData).length === 0) {
			throw new Error("mutableData is required for schema-based collections");
		}

		const errors = validateMutableUpdate(schema, mutableData);
		if (errors.length > 0) {
			const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
			throw new Error(`Schema validation failed: ${messages}`);
		}

		// Merge in JS and write the FULL merged result (hash must match stored value)
		const existingMutable = (nft.mutable_data ?? {}) as Record<string, unknown>;
		const merged = { ...existingMutable, ...mutableData };
		const dataHash = computeDataHashSync(merged);

		await updateNftMutableData(
			nftId, merged, dataHash,
			op.txId, op.blockNum,
			txn,
		);
	} else {
		throw new Error(`Collection ${nft.collection_id} requires a schema for set_data_from`);
	}
}
