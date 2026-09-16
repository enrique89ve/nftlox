import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getNftForProcessing,
	updateNftDataRef,
} from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { requireString, requireObject, optionalStoredCollectionSchema } from "@/utils/validation.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { computeDataHash, validateMutableSnapshot } from "@/protocol/index.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleSetData(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const nftId = requireString(op.data.nftId, "nftId");
	const nftDna = requireString(op.data.nftDna, "nftDna");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw protocolReject(`NFT not found: ${nftId}`);
	if (nft.nft_dna !== nftDna) throw protocolReject(`NFT DNA mismatch for ${nftId}`);

	await validateSeedProvenance(op, nft, txn);

	const collection = await getCollectionRules(nft.collection_id, txn);
	const schema = optionalStoredCollectionSchema(collection?.schema);

	if (!schema) {
		throw protocolReject(`Collection ${nft.collection_id} requires a schema for set_data`);
	}

	// Only creator can write mutable data
	if (!collection || collection.creator !== op.signer) {
		throw protocolReject(`Signer ${op.signer} is not the creator of collection ${nft.collection_id}`);
	}

	// REPLACE semantics: caller sends complete data, validated against schema
	const mutableData = requireObject(op.data.mutableData, "mutableData") as Record<string, unknown>;
	if (Object.keys(mutableData).length === 0) {
		throw protocolReject("mutableData cannot be empty");
	}

	const errors = validateMutableSnapshot(schema, mutableData);
	if (errors.length > 0) {
		throw protocolReject(`Schema validation failed: ${formatSchemaErrors(errors)}`);
	}

	const dataHash = await computeDataHash(mutableData);

	await updateNftDataRef(nftId, dataHash, op.operationId, txn);

	return [nftId];
}
