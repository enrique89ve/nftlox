import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { COLLECTION_STATUS_ARCHIVED, getCollectionRules } from "@/db/queries/collections.ts";
import { insertNft, nftExists } from "@/db/queries/nfts.ts";
import {
	requireBoundedString,
	requireUsername,
	optionalString,
	optionalBoundedString,
	optionalNumber,
	optionalObject,
	optionalCollectionSchema,
} from "@/utils/validation.ts";
import { resolveNftType, validateSeedCap } from "@/utils/nft-rules.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { createLogger } from "@/utils/logger.ts";
import {
	validateMintData,
	computeDataHash,
	generateOriginDna,
	generateInstanceDna,
	MAX_ID_LENGTH,
	MAX_NAME_LENGTH,
	MAX_IMAGE_URL_LENGTH,
} from "@/protocol/index.ts";

const log = createLogger("mint");

export async function handleMint(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireBoundedString(d.id, "id", MAX_ID_LENGTH);
	const collectionId = requireBoundedString(d.collectionId, "collectionId", MAX_ID_LENGTH);

	if (await nftExists(id, txn)) {
		log.info("Mint skipped: NFT already exists", { nftId: id, signer: op.signer, txId: op.txId });
		return;
	}
	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) throw new Error(`Only the collection creator can mint in ${collectionId}`);
	if (collection.status === COLLECTION_STATUS_ARCHIVED) throw new Error(`Collection ${collectionId} is archived`);

	const metadata = optionalObject(d.metadata) ?? {};
	const nftType = resolveNftType(optionalString(d.nftType), id);
	if (nftType !== "seed") {
		throw new Error("Only seeds can be minted directly. Instances are created via bulk_distribute");
	}

	validateSeedCap(collectionId, collection.seed_count, collection.total_potential);

	const schema = optionalCollectionSchema(collection.schema);
	const immutableData = optionalObject(d.immutableData) as Record<string, unknown> | null;
	const mutableData = optionalObject(d.mutableData);

	if (schema) {
		const errors = validateMintData(schema, immutableData ?? undefined, mutableData ?? undefined);
		if (errors.length > 0) {
			throw new Error(`Schema validation failed: ${formatSchemaErrors(errors)}`);
		}
	}

	const dataHash = mutableData ? await computeDataHash(mutableData) : null;

	// DNA is always computed by the indexer — never trust user-supplied values.
	const edition = optionalNumber(d.edition) ?? 1;
	const imageHash = optionalString(metadata.imageHash) ?? "";
	const originDna = await generateOriginDna(collectionId);
	const instanceDna = await generateInstanceDna(id, originDna, edition, imageHash);
	const ownerRaw = optionalString(d.owner);
	const owner = ownerRaw ? requireUsername(ownerRaw, "owner") : op.signer;

	const maxReplicas = optionalNumber(d.maxReplicas) ?? 1;
	if (maxReplicas < 1) {
		throw new Error(`maxReplicas must be >= 1 for seeds, got ${maxReplicas}`);
	}

	await insertNft({
		id, collectionId, nftType: "seed",
		edition,
		owner,
		originDna,
		instanceDna,
		name: optionalBoundedString(metadata.name, "metadata.name", MAX_NAME_LENGTH) ?? optionalBoundedString(d.name, "name", MAX_NAME_LENGTH) ?? "",
		imageUrl: optionalBoundedString(metadata.imageUrl, "metadata.imageUrl", MAX_IMAGE_URL_LENGTH),
		maxReplicas,
		seedId: null, instanceNumber: null, originalId: null,
		immutableData: immutableData && Object.keys(immutableData).length > 0 ? immutableData : null,
		dataOperationId: mutableData ? op.operationId : null,
		dataHash,
		schemaVersion: collection.schema_version,
		operationId: op.operationId,
		blockNum: op.blockNum, txId: op.txId, createdAt: op.timestamp,
	}, txn);
}
