// NFTLox Payload Creation Module
// Creates JSON payloads for all protocol actions

import {
	SAFE_PAYLOAD_MAX_BYTES,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_REPLICATE,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_PACK_CREATE,
	ACTION_PACK_BUY,
	ACTION_PACK_TRANSFER,
	ACTION_PACK_OPEN,
	ACTION_PACK_DESTROY,
	ACTION_PACK_APPROVE,
	ACTION_PACK_TRANSFER_FROM,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
	ACTION_SET_OWNER_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_BUY,
	type ProtocolAction,
} from "./constants";

import type {
	CollectionData,
	NFTData,
	ReplicaData,
	SeedProvenance,
	TransferData,
	SetDataData,
	SetDataInput,
	DataOperatorApproveData,
	DataOperatorApproveInput,
	SetDataFromData,
	SetDataFromInput,
	SetOwnerDataData,
	SetOwnerDataInput,
	ExtendSchemaData,
	ExtendSchemaInput,
	ArchiveCollectionData,
	ArchiveCollectionInput,
	BulkDistributeData,
	BulkDistributeInput,
	ListingData,
	UnlistData,
	BuyData,
	PackCreateData,
	PackBuyData,
	PackTransferData,
	PackOpenData,
	PackDestroyData,
	PackCreateInput,
	PackBuyInput,
	PackTransferInput,
	PackOpenInput,
	PackDestroyInput,
	PackApproveData,
	PackApproveInput,
	PackTransferFromData,
	PackTransferFromInput,
	NftApproveData,
	NftApproveInput,
	NftApproveAllData,
	NftApproveAllInput,
	NftTransferFromData,
	NftTransferFromInput,
	NftLendData,
	NftLendInput,
	NftReturnData,
	NftReturnInput,
	ProtocolPayload,
	ReplicateInput,
	ListInput,
	BurnInput,
	UnlistInput,
	HiveOperation,
	SchemaFieldType,
} from "./types";

import {
	generateOriginDna,
	generateInstanceDna,
	generateReplicaInstanceDna,
	generateImageHash,
	generateReplicaId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicPackId,
} from "./dna";

import { getProtocolVersion, getProtocolId } from "./protocol-state";
import { ACTION_AUTH_LEVEL, type AuthLevel } from "./constants";

/**
 * Creates a protocol payload envelope with protocol ID and version injected automatically.
 * Uses runtime state from initProtocol() if initialized, otherwise falls back to constants.
 */
export function makePayload<T>(action: ProtocolAction, data: T): ProtocolPayload<T> {
	return { protocol: getProtocolId(), version: getProtocolVersion(), action, data };
}

export class PayloadTooLargeError extends Error {
	readonly payloadBytes: number;
	readonly maxBytes: number;
	readonly suggestedMaxItems: number;

	constructor(payloadBytes: number, maxBytes: number, itemCount: number) {
		const ratio = maxBytes / payloadBytes;
		const suggestedMaxItems = Math.max(1, Math.floor(itemCount * ratio));

		super(
			`Payload too large: ${payloadBytes} bytes (limit: ${maxBytes}). ` +
			`Try reducing to ~${suggestedMaxItems} items per batch, or remove imageOverrides/optional fields.`,
		);

		this.name = "PayloadTooLargeError";
		this.payloadBytes = payloadBytes;
		this.maxBytes = maxBytes;
		this.suggestedMaxItems = suggestedMaxItems;
	}
}

function safeStringify(payload: unknown, itemCount = 0): string {
	const json = JSON.stringify(payload);
	if (json.length > SAFE_PAYLOAD_MAX_BYTES) {
		throw new PayloadTooLargeError(json.length, SAFE_PAYLOAD_MAX_BYTES, itemCount);
	}
	return json;
}

export function toHiveOperation(
	payload: ProtocolPayload<unknown>,
	signer: string,
): HiveOperation {
	return buildHiveOperation(payload, signer);
}

/**
 * Build a Hive custom_json operation with auth derived from ACTION_AUTH_LEVEL.
 * Single point where auth fields are set — never hardcode required_auths elsewhere.
 */
function buildHiveOperation(
	payload: ProtocolPayload<unknown>,
	signer: string,
	authOverride?: AuthLevel,
): HiveOperation {
	const level = authOverride ?? ACTION_AUTH_LEVEL[payload.action as ProtocolAction] ?? "posting";
	const json = safeStringify(payload);
	return [
		"custom_json",
		level === "active"
			? { required_auths: [signer], required_posting_auths: [], id: getProtocolId(), json }
			: { required_auths: [], required_posting_auths: [signer], id: getProtocolId(), json },
	];
}


/** Spread seed provenance fields only when present */
function spreadProvenance(p?: SeedProvenance): Record<string, string> {
	if (!p) return {};
	return {
		...(p.seedId && { seedId: p.seedId }),
		...(p.seedTxId && { seedTxId: p.seedTxId }),
	};
}

// ============ COLLECTION PAYLOADS ============

export function createArchiveCollectionPayload(
	input: ArchiveCollectionInput,
): ProtocolPayload<ArchiveCollectionData> {
	return makePayload(ACTION_ARCHIVE_COLLECTION, {
		collectionId: input.collectionId,
	});
}

export function createArchiveCollectionOperation(
	input: ArchiveCollectionInput,
	creator: string,
): HiveOperation {
	const payload = createArchiveCollectionPayload(input);
	return buildHiveOperation(payload, creator);
}

// ============ MINT PAYLOADS ============

// ============ REPLICATE PAYLOADS ============

export async function createReplicatePayload(
	input: ReplicateInput,
): Promise<ProtocolPayload<ReplicaData>> {
	const instanceDna = await generateReplicaInstanceDna(
		input.originDna,
		input.originalInstanceDna,
	);

	return makePayload(ACTION_REPLICATE, {
		id: await generateReplicaId(input.originalId),
		originalId: input.originalId,
		newOwner: input.newOwner,
		originDna: input.originDna,
		instanceDna,
		...spreadProvenance(input),
	});
}

// ============ BULK DISTRIBUTE PAYLOADS ============

export function createBulkDistributePayload(
	input: BulkDistributeInput,
): ProtocolPayload<BulkDistributeData> {
	return makePayload(ACTION_BULK_DISTRIBUTE, {
		...(input.to && { to: input.to }),
		items: input.items.map(item => ({
			seedId: item.seedId,
			quantity: item.quantity,
			seedTxId: item.seedTxId,
		})),
		...(input.imageOverrides && { imageOverrides: input.imageOverrides }),
		...(input.data && { data: input.data }),
		...(input.mutableData && { mutableData: input.mutableData }),
	});
}

export function createBulkDistributeOperation(
	input: BulkDistributeInput,
	signer: string,
): HiveOperation {
	const payload = createBulkDistributePayload(input);
	return buildHiveOperation(payload, signer);
}

// ============ TRANSFER PAYLOADS ============
// Burn = transfer(to: "null"). Supports single nftId or bulk nftIds.

export function createTransferPayload(
	nftId: string,
	from: string,
	to: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): ProtocolPayload<TransferData> {
	return makePayload(ACTION_TRANSFER, {
		nftId,
		from,
		to,
		...(imageUrl && { imageUrl }),
		...(imageHash && { imageHash }),
		...spreadProvenance(provenance),
	});
}

export function createBulkTransferPayload(
	nftIds: string[],
	from: string,
	to: string,
): ProtocolPayload<TransferData> {
	return makePayload(ACTION_TRANSFER, { nftIds, from, to });
}

// ============ BURN PAYLOADS (via transfer to null) ============

export function createBurnPayload(
	nftId: string,
	owner: string,
): ProtocolPayload<TransferData> {
	return createTransferPayload(nftId, owner, "null");
}

export function createBulkBurnPayload(
	nftIds: string[],
	owner: string,
): ProtocolPayload<TransferData> {
	return createBulkTransferPayload(nftIds, owner, "null");
}

// ============ SET_DATA PAYLOADS ============

/**
 * Create a set_data payload to update an NFT's mutable data.
 * Only the collection creator can call this (posting key).
 */
export function createSetDataPayload(
	input: SetDataInput,
): ProtocolPayload<SetDataData> {
	return makePayload(ACTION_SET_DATA, {
		nftId: input.nftId,
		instanceDna: input.instanceDna,
		...(input.data && { data: input.data }),
		...(input.mutableData && { mutableData: input.mutableData }),
		...spreadProvenance(input),
	});
}

export function createSetDataOperation(
	input: SetDataInput,
	issuer: string,
): HiveOperation {
	const payload = createSetDataPayload(input);
	return buildHiveOperation(payload, issuer);
}

// ============ DATA OPERATOR PAYLOADS ============

export function createDataOperatorApprovePayload(
	input: DataOperatorApproveInput,
): ProtocolPayload<DataOperatorApproveData> {
	return makePayload(ACTION_DATA_OPERATOR_APPROVE, {
		collectionId: input.collectionId,
		operator: input.operator,
		approved: input.approved,
	});
}

export function createDataOperatorApproveOperation(
	input: DataOperatorApproveInput,
	creator: string,
): HiveOperation {
	const payload = createDataOperatorApprovePayload(input);
	return buildHiveOperation(payload, creator);
}

export function createSetDataFromPayload(
	input: SetDataFromInput,
): ProtocolPayload<SetDataFromData> {
	return makePayload(ACTION_SET_DATA_FROM, {
		nftId: input.nftId,
		instanceDna: input.instanceDna,
		...(input.data && { data: input.data }),
		...(input.mutableData && { mutableData: input.mutableData }),
		...spreadProvenance(input),
	});
}

export function createSetDataFromOperation(
	input: SetDataFromInput,
	operator: string,
): HiveOperation {
	const payload = createSetDataFromPayload(input);
	return buildHiveOperation(payload, operator);
}

// ============ SET_OWNER_DATA PAYLOADS ============

export function createSetOwnerDataPayload(
	input: SetOwnerDataInput,
): ProtocolPayload<SetOwnerDataData> {
	return makePayload(ACTION_SET_OWNER_DATA, {
		nftId: input.nftId,
		instanceDna: input.instanceDna,
		data: input.data,
		...spreadProvenance(input),
	});
}

export function createSetOwnerDataOperation(
	input: SetOwnerDataInput,
	owner: string,
): HiveOperation {
	const payload = createSetOwnerDataPayload(input);
	return buildHiveOperation(payload, owner);
}

// ============ EXTEND_SCHEMA PAYLOADS ============

export function createExtendSchemaPayload(
	input: ExtendSchemaInput,
): ProtocolPayload<ExtendSchemaData> {
	return makePayload(ACTION_EXTEND_SCHEMA, {
		collectionId: input.collectionId,
		...(input.newImmutableFields && { newImmutableFields: input.newImmutableFields }),
		...(input.newMutableFields && { newMutableFields: input.newMutableFields }),
	});
}

export function createExtendSchemaOperation(
	input: ExtendSchemaInput,
	creator: string,
): HiveOperation {
	const payload = createExtendSchemaPayload(input);
	return buildHiveOperation(payload, creator);
}

// ============ MARKETPLACE PAYLOADS ============

export function createListPayload(
	input: ListInput,
	listingId: string,
	listingNonce: string,
): ProtocolPayload<ListingData> {
	return makePayload(ACTION_LIST, {
		nftId: input.nftId,
		listingId,
		listingNonce,
		price: input.price,
		...(input.expiresAt && { expiresAt: input.expiresAt }),
		...(input.imageUrl && { imageUrl: input.imageUrl }),
		...(input.imageHash && { imageHash: input.imageHash }),
		...(input.marketplace && { marketplace: input.marketplace }),
		...spreadProvenance(input),
	});
}

export function createUnlistPayload(
	nftId: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): ProtocolPayload<UnlistData> {
	return makePayload(ACTION_UNLIST, {
		nftId,
		...(imageUrl && { imageUrl }),
		...(imageHash && { imageHash }),
		...spreadProvenance(provenance),
	});
}

export function createBuyPayload(data: BuyData): ProtocolPayload<BuyData> {
	return makePayload(ACTION_BUY, data);
}

export function createBuyOperation(data: BuyData, nodeAccount: string): HiveOperation {
	const payload = createBuyPayload(data);
	return buildHiveOperation(payload, nodeAccount);
}

// ============ HIVE OPERATION CREATION ============

export async function createReplicateOperation(input: ReplicateInput): Promise<HiveOperation> {
	const payload = await createReplicatePayload(input);
	return buildHiveOperation(payload, input.currentOwner);
}

export function createTransferOperation(
	nftId: string,
	from: string,
	to: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): HiveOperation {
	const payload = createTransferPayload(nftId, from, to, imageUrl, imageHash, provenance);
	return buildHiveOperation(payload, from);
}

export function createBurnOperation(
	nftId: string,
	owner: string,
): HiveOperation {
	const payload = createBurnPayload(nftId, owner);
	return buildHiveOperation(payload, owner);
}

export function createBulkBurnOperation(
	nftIds: string[],
	owner: string,
): HiveOperation {
	const payload = createBulkBurnPayload(nftIds, owner);
	return buildHiveOperation(payload, owner);
}

export function createListOperation(
	input: ListInput,
	owner: string,
	listingId: string,
	listingNonce: string,
): HiveOperation {
	const payload = createListPayload(input, listingId, listingNonce);
	return buildHiveOperation(payload, owner);
}

export function createUnlistOperation(
	nftId: string,
	owner: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): HiveOperation {
	const payload = createUnlistPayload(nftId, imageUrl, imageHash, provenance);
	return buildHiveOperation(payload, owner);
}

// ============ DETERMINISTIC PAYLOAD CREATION (ANTI-DUPLICATION) ============

export interface DeterministicCollectionInput {
	name: string;
	symbol: string;
	creator: string;
	totalPotential: number;
	metadata: {
		description: string;
		image: string;
		externalUrl?: string;
	};
	rules: {
		transferable: boolean;
		burnable: boolean;
		replicable: boolean;
		royaltyPct: number;
		royaltyRecipient?: string;
	};
	schema?: {
		immutable: Array<{ name: string; type: SchemaFieldType }>;
		mutable: Array<{ name: string; type: SchemaFieldType }>;
	};
}

/**
 * Creates a collection payload with a deterministic ID.
 * Same creator + name + symbol always produces the same collectionId.
 */
export async function createDeterministicCollectionPayload(
	input: DeterministicCollectionInput,
): Promise<ProtocolPayload<CollectionData>> {
	const id = await generateDeterministicCollectionId(
		input.creator,
		input.name,
		input.symbol,
	);
	const originDna = await generateOriginDna(id);

	return makePayload(ACTION_CREATE_COLLECTION, {
		id,
		name: input.name,
		symbol: input.symbol.toUpperCase(),
		creator: input.creator,
		totalPotential: input.totalPotential,
		originDna,
		metadata: input.metadata,
		rules: input.rules,
		...(input.schema && { schema: input.schema }),
	});
}

export async function createDeterministicCollectionOperation(
	input: DeterministicCollectionInput,
): Promise<HiveOperation> {
	const payload = await createDeterministicCollectionPayload(input);
	return toHiveOperation(payload, input.creator);
}

export interface DeterministicMintInput {
	artId: string;
	collectionId: string;
	collectionOriginDna: string;
	edition: number;
	owner: string;
	nftType?: "seed" | "instance";
	name: string;
	description?: string;
	imageUrl: string;
	imageHash?: string;
	maxReplicas?: number;
	collectionBlock?: number;
	immutableData?: Record<string, unknown>;
	mutableData?: Record<string, unknown>;
}

/**
 * Creates a seed mint payload with a deterministic seedId.
 * Same collectionId + artId always produces the same seedId.
 */
export async function createDeterministicMintPayload(
	input: DeterministicMintInput,
): Promise<ProtocolPayload<NFTData>> {
	const seedId = await generateDeterministicSeedId(input.collectionId, input.artId);
	const imageHash = input.imageHash || await generateImageHash(input.imageUrl);
	const instanceDna = await generateInstanceDna(
		seedId,
		input.collectionOriginDna,
		input.edition,
		imageHash,
	);
	return makePayload(ACTION_MINT, {
		id: seedId,
		collectionId: input.collectionId,
		edition: input.edition,
		owner: input.owner,
		originDna: input.collectionOriginDna,
		instanceDna,
		mintedBy: input.owner,
		...(input.collectionBlock !== undefined && { collectionBlock: input.collectionBlock }),
		metadata: {
			name: input.name,
			description: input.description,
			imageUrl: input.imageUrl,
			imageHash,
		},
		maxReplicas: input.maxReplicas ?? 1,
		...(input.nftType && { nftType: input.nftType }),
		...(input.immutableData && { immutableData: input.immutableData }),
		...(input.mutableData && { mutableData: input.mutableData }),
	});
}

export async function createDeterministicMintOperation(
	input: DeterministicMintInput,
	signer: string,
): Promise<HiveOperation> {
	const payload = await createDeterministicMintPayload(input);
	return toHiveOperation(payload, signer);
}

// ============ PACK PAYLOADS ============

export async function createPackCreatePayload(
	input: PackCreateInput,
	creator: string,
): Promise<ProtocolPayload<PackCreateData>> {
	const id = await generateDeterministicPackId(input.collectionId, input.name);
	return makePayload(ACTION_PACK_CREATE, {
		id,
		collectionId: input.collectionId,
		name: input.name,
		...(input.description && { description: input.description }),
		...(input.imageUrl && { imageUrl: input.imageUrl }),
		dropTable: input.dropTable,
		itemsPerPack: input.itemsPerPack,
		...(input.price && { price: input.price }),
		maxSupply: input.maxSupply,
	});
}

export function createPackBuyPayload(
	input: PackBuyInput,
): ProtocolPayload<PackBuyData> {
	return makePayload(ACTION_PACK_BUY, {
		packId: input.packId,
		quantity: input.quantity,
	});
}

export function createPackTransferPayload(
	input: PackTransferInput,
): ProtocolPayload<PackTransferData> {
	return makePayload(ACTION_PACK_TRANSFER, {
		packId: input.packId,
		to: input.to,
		quantity: input.quantity,
	});
}

export function createPackOpenPayload(
	input: PackOpenInput,
): ProtocolPayload<PackOpenData> {
	return makePayload(ACTION_PACK_OPEN, {
		packId: input.packId,
		quantity: input.quantity,
	});
}

// ============ PACK HIVE OPERATIONS ============

export async function createPackCreateOperation(
	input: PackCreateInput,
	creator: string,
): Promise<HiveOperation> {
	const payload = await createPackCreatePayload(input, creator);
	return buildHiveOperation(payload, creator);
}

export function createPackBuyOperation(
	input: PackBuyInput,
	buyer: string,
): HiveOperation {
	const payload = createPackBuyPayload(input);
	return buildHiveOperation(payload, buyer);
}

export function createPackTransferOperation(
	input: PackTransferInput,
	from: string,
): HiveOperation {
	const payload = createPackTransferPayload(input);
	return buildHiveOperation(payload, from);
}

export function createPackOpenOperation(
	input: PackOpenInput,
	opener: string,
): HiveOperation {
	const payload = createPackOpenPayload(input);
	return buildHiveOperation(payload, opener);
}

export function createPackDestroyPayload(
	input: PackDestroyInput,
): ProtocolPayload<PackDestroyData> {
	return makePayload(ACTION_PACK_DESTROY, {
		packId: input.packId,
	});
}

export function createPackDestroyOperation(
	input: PackDestroyInput,
	creator: string,
): HiveOperation {
	const payload = createPackDestroyPayload(input);
	return buildHiveOperation(payload, creator);
}

// ============ APPROVE & TRANSFER_FROM PAYLOADS ============

export function createPackApprovePayload(
	input: PackApproveInput,
): ProtocolPayload<PackApproveData> {
	return makePayload(ACTION_PACK_APPROVE, {
		spender: input.spender,
		packId: input.packId,
		quantity: input.quantity,
		approved: input.approved,
	});
}

export function createPackTransferFromPayload(
	input: PackTransferFromInput,
): ProtocolPayload<PackTransferFromData> {
	return makePayload(ACTION_PACK_TRANSFER_FROM, {
		from: input.from,
		to: input.to,
		packId: input.packId,
		quantity: input.quantity,
	});
}

export function createNftApprovePayload(
	input: NftApproveInput,
): ProtocolPayload<NftApproveData> {
	return makePayload(ACTION_NFT_APPROVE, {
		spender: input.spender,
		instanceId: input.instanceId,
		approved: input.approved,
	});
}

export function createNftApproveAllPayload(
	input: NftApproveAllInput,
): ProtocolPayload<NftApproveAllData> {
	return makePayload(ACTION_NFT_APPROVE_ALL, {
		spender: input.spender,
		collectionId: input.collectionId,
		approved: input.approved,
	});
}

export function createNftTransferFromPayload(
	input: NftTransferFromInput,
): ProtocolPayload<NftTransferFromData> {
	return makePayload(ACTION_NFT_TRANSFER_FROM, {
		from: input.from,
		to: input.to,
		instanceId: input.instanceId,
		...spreadProvenance(input),
	});
}

// ============ APPROVE & TRANSFER_FROM OPERATIONS ============
// Approve operations require active key; transfer_from uses posting (gate was at approve)

export function createPackApproveOperation(
	input: PackApproveInput,
	owner: string,
): HiveOperation {
	const payload = createPackApprovePayload(input);
	return buildHiveOperation(payload, owner);
}

export function createPackTransferFromOperation(
	input: PackTransferFromInput,
	spender: string,
): HiveOperation {
	const payload = createPackTransferFromPayload(input);
	return buildHiveOperation(payload, spender);
}

export function createNftApproveOperation(
	input: NftApproveInput,
	owner: string,
): HiveOperation {
	const payload = createNftApprovePayload(input);
	return buildHiveOperation(payload, owner);
}

export function createNftApproveAllOperation(
	input: NftApproveAllInput,
	owner: string,
): HiveOperation {
	const payload = createNftApproveAllPayload(input);
	return buildHiveOperation(payload, owner);
}

export function createNftTransferFromOperation(
	input: NftTransferFromInput,
	spender: string,
): HiveOperation {
	const payload = createNftTransferFromPayload(input);
	return buildHiveOperation(payload, spender);
}

// ============ LENDING PAYLOADS & OPERATIONS ============

export function createNftLendPayload(
	input: NftLendInput,
): ProtocolPayload<NftLendData> {
	return makePayload(ACTION_NFT_LEND, {
		instanceId: input.instanceId,
		borrower: input.borrower,
		...spreadProvenance(input),
	});
}

export function createNftReturnPayload(
	input: NftReturnInput,
): ProtocolPayload<NftReturnData> {
	return makePayload(ACTION_NFT_RETURN, {
		instanceId: input.instanceId,
		...spreadProvenance(input),
	});
}

export function createNftLendOperation(
	input: NftLendInput,
	owner: string,
): HiveOperation {
	const payload = createNftLendPayload(input);
	return buildHiveOperation(payload, owner);
}

export function createNftReturnOperation(
	input: NftReturnInput,
	signer: string,
): HiveOperation {
	const payload = createNftReturnPayload(input);
	return buildHiveOperation(payload, signer);
}
