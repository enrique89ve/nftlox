import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getCollectionRules, countSeedsByCreator } from "@/db/queries/collections.ts";
import { insertNft, nftExists, isBurnedId } from "@/db/queries/nfts.ts";
import { assertWithinLimit } from "@/utils/action-limits.ts";
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
	generateDeterministicSeedId,
	ACTION_MINT,
	MAX_ID_LENGTH,
	MAX_ART_ID_LENGTH,
	MAX_NAME_LENGTH,
	MAX_IMAGE_URL_LENGTH,
} from "@/protocol/index.ts";

const log = createLogger("mint");

export async function handleMint(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const d = op.data;
	const payloadId = requireBoundedString(d.id, "id", MAX_ID_LENGTH);
	const collectionId = requireBoundedString(d.collectionId, "collectionId", MAX_ID_LENGTH);
	const artId = requireBoundedString(d.artId, "artId", MAX_ART_ID_LENGTH);

	// Recompute the canonical seedId and reject any payload that tries to supply
	// a non-canonical id. Same pattern as handleCreateCollection — the chain is
	// the source of truth for the creator/collection/artId tuple, but the id
	// itself is a pure function of that tuple, so clients cannot choose it.
	const canonicalId = await generateDeterministicSeedId(collectionId, artId);
	if (payloadId !== canonicalId) {
		throw new Error(
			`Non-canonical seedId: expected ${canonicalId} for (collection ${collectionId}, artId ${artId}), got ${payloadId}`,
		);
	}

	// Resurrection guard: once an id has been burned it must never be re-minted,
	// even if the (collectionId, artId) tuple would regenerate the same hash.
	// Without this, a seed that reached distributed=0 could be burned and silently
	// re-created under the same identity with different immutableData — breaking
	// every downstream cache that treated the id as permanent.
	if (await isBurnedId(canonicalId, txn)) {
		throw new Error(
			`Mint rejected: id ${canonicalId} was previously burned. Seed ids are not reusable after burn.`,
		);
	}

	if (await nftExists(canonicalId, txn)) {
		log.info("Mint skipped: NFT already exists", { nftId: canonicalId, signer: op.signer, txId: op.txId });
		return [];
	}
	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) throw new Error(`Only the collection creator can mint in ${collectionId}`);

	const metadata = optionalObject(d.metadata) ?? {};
	const nftType = resolveNftType(optionalString(d.nftType), canonicalId);
	if (nftType !== "seed") {
		throw new Error("Only seeds can be minted directly. Instances are created via bulk_distribute");
	}

	validateSeedCap(collectionId, collection.seed_count, collection.total_potential);

	// Per-creator seed cap (aggregate across all of the signer's collections).
	// Signer is the creator here — handleMint above already enforces
	// `collection.creator !== op.signer` rejection.
	const seedsByCreator = await countSeedsByCreator(op.signer, txn);
	await assertWithinLimit("seedsPerCreator", op.signer, seedsByCreator);

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
	const instanceDna = await generateInstanceDna(canonicalId, originDna, edition, imageHash);
	const ownerRaw = optionalString(d.owner);
	const owner = ownerRaw ? requireUsername(ownerRaw, "owner") : op.signer;

	const maxSupply = optionalNumber(d.maxSupply) ?? 1;
	if (maxSupply < 1) {
		throw new Error(`maxSupply must be >= 1 for seeds, got ${maxSupply}`);
	}

	await insertNft({
		id: canonicalId, collectionId, nftType: "seed",
		edition,
		owner,
		originDna,
		instanceDna,
		name: optionalBoundedString(metadata.name, "metadata.name", MAX_NAME_LENGTH) ?? optionalBoundedString(d.name, "name", MAX_NAME_LENGTH) ?? "",
		imageUrl: optionalBoundedString(metadata.imageUrl, "metadata.imageUrl", MAX_IMAGE_URL_LENGTH),
		maxSupply,
		seedId: null, instanceNumber: null,
		artId,
		immutableData: immutableData && Object.keys(immutableData).length > 0 ? immutableData : null,
		dataOperationId: mutableData ? op.operationId : null,
		dataHash,
		schemaVersion: collection.schema_version,
		ownerOperationId: op.operationId,
		ownerAction: ACTION_MINT,
		ownerBlockNum: op.blockNum,
		createdOperationId: op.operationId,
		createdBlockNum: op.blockNum,
		createdTxId: op.txId,
		createdAt: op.timestamp,
	}, txn);

	return [canonicalId];
}
