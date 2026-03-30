// NFTLox Payload Creation Module
// Creates JSON payloads for all protocol actions

import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	SAFE_PAYLOAD_MAX_BYTES,
	ATOMIC_TRACKING_AMOUNT,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_BURN,
	ACTION_REPLICATE,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_PACK_CREATE,
	ACTION_PACK_BUY,
	ACTION_PACK_TRANSFER,
	ACTION_PACK_OPEN,
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
} from "./constants";

import type {
	CollectionData,
	NFTData,
	ReplicaData,
	SeedProvenance,
	TransferData,
	BurnData,
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
	PackCreateInput,
	PackBuyInput,
	PackTransferInput,
	PackOpenInput,
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
	TransferMemo,
	AtomicTransferInput,
	HiveTransferOperation,
	AtomicOperation,
	SchemaFieldType,
} from "./types";

import {
	generateOriginDna,
	generateInstanceDna,
	generateReplicaInstanceDna,
	generateAccessKey,
	generateImageHash,
	generateReplicaId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicPackId,
} from "./dna";

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
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [signer],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
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
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_ARCHIVE_COLLECTION,
		data: {
			collectionId: input.collectionId,
		},
	};
}

export function createArchiveCollectionOperation(
	input: ArchiveCollectionInput,
	creator: string,
): HiveOperation {
	const payload = createArchiveCollectionPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [creator],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
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
	const uniqueAccessKey = await generateAccessKey(instanceDna, input.newOwner);

	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_REPLICATE,
		data: {
			id: await generateReplicaId(input.originalId),
			originalId: input.originalId,
			newOwner: input.newOwner,
			originDna: input.originDna,
			instanceDna,
			uniqueAccessKey,
			...spreadProvenance(input),
		},
	};
}

// ============ BULK DISTRIBUTE PAYLOADS ============

export function createBulkDistributePayload(
	input: BulkDistributeInput,
): ProtocolPayload<BulkDistributeData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_BULK_DISTRIBUTE,
		data: {
			...(input.to && { to: input.to }),
			items: input.items.map(item => ({
				seedId: item.seedId,
				quantity: item.quantity,
				seedTxId: item.seedTxId,
			})),
			...(input.imageOverrides && { imageOverrides: input.imageOverrides }),
			...(input.data && { data: input.data }),
			...(input.mutableData && { mutableData: input.mutableData }),
		},
	};
}

export function createBulkDistributeOperation(
	input: BulkDistributeInput,
	signer: string,
): HiveOperation {
	const payload = createBulkDistributePayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [signer],
			id: PROTOCOL_ID,
			json: safeStringify(payload, input.items.length),
		},
	];
}

// ============ TRANSFER PAYLOADS ============

export function createTransferPayload(
	nftId: string,
	from: string,
	to: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): ProtocolPayload<TransferData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_TRANSFER,
		data: {
			nftId,
			from,
			to,
			...(imageUrl && { imageUrl }),
			...(imageHash && { imageHash }),
			...spreadProvenance(provenance),
		},
	};
}

// ============ BURN PAYLOADS ============

export function createBurnPayload(
	nftId: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): ProtocolPayload<BurnData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_BURN,
		data: {
			nftId,
			...(imageUrl && { imageUrl }),
			...(imageHash && { imageHash }),
			...spreadProvenance(provenance),
		},
	};
}

// ============ SET_DATA PAYLOADS ============

/**
 * Create a set_data payload to update an NFT's mutable data.
 * Only the collection creator can call this (posting key).
 */
export function createSetDataPayload(
	input: SetDataInput,
): ProtocolPayload<SetDataData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_SET_DATA,
		data: {
			nftId: input.nftId,
			instanceDna: input.instanceDna,
			...(input.data && { data: input.data }),
			...(input.mutableData && { mutableData: input.mutableData }),
			...spreadProvenance(input),
		},
	};
}

export function createSetDataOperation(
	input: SetDataInput,
	issuer: string,
): HiveOperation {
	const payload = createSetDataPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [issuer],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

// ============ DATA OPERATOR PAYLOADS ============

export function createDataOperatorApprovePayload(
	input: DataOperatorApproveInput,
): ProtocolPayload<DataOperatorApproveData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_DATA_OPERATOR_APPROVE,
		data: {
			collectionId: input.collectionId,
			operator: input.operator,
			approved: input.approved,
		},
	};
}

export function createDataOperatorApproveOperation(
	input: DataOperatorApproveInput,
	creator: string,
): HiveOperation {
	const payload = createDataOperatorApprovePayload(input);
	return [
		"custom_json",
		{
			required_auths: [creator],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createSetDataFromPayload(
	input: SetDataFromInput,
): ProtocolPayload<SetDataFromData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_SET_DATA_FROM,
		data: {
			nftId: input.nftId,
			instanceDna: input.instanceDna,
			...(input.data && { data: input.data }),
			...(input.mutableData && { mutableData: input.mutableData }),
			...spreadProvenance(input),
		},
	};
}

export function createSetDataFromOperation(
	input: SetDataFromInput,
	operator: string,
): HiveOperation {
	const payload = createSetDataFromPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [operator],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

// ============ SET_OWNER_DATA PAYLOADS ============

export function createSetOwnerDataPayload(
	input: SetOwnerDataInput,
): ProtocolPayload<SetOwnerDataData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_SET_OWNER_DATA,
		data: {
			nftId: input.nftId,
			instanceDna: input.instanceDna,
			data: input.data,
			...spreadProvenance(input),
		},
	};
}

export function createSetOwnerDataOperation(
	input: SetOwnerDataInput,
	owner: string,
): HiveOperation {
	const payload = createSetOwnerDataPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

// ============ EXTEND_SCHEMA PAYLOADS ============

export function createExtendSchemaPayload(
	input: ExtendSchemaInput,
): ProtocolPayload<ExtendSchemaData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_EXTEND_SCHEMA,
		data: {
			collectionId: input.collectionId,
			...(input.newImmutableFields && { newImmutableFields: input.newImmutableFields }),
			...(input.newMutableFields && { newMutableFields: input.newMutableFields }),
		},
	};
}

export function createExtendSchemaOperation(
	input: ExtendSchemaInput,
	creator: string,
): HiveOperation {
	const payload = createExtendSchemaPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [creator],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

// ============ MARKETPLACE PAYLOADS ============

export function createListPayload(
	input: ListInput,
	listingId: string,
	listingNonce: string,
): ProtocolPayload<ListingData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_LIST,
		data: {
			nftId: input.nftId,
			listingId,
			listingNonce,
			price: input.price,
			...(input.expiresAt && { expiresAt: input.expiresAt }),
			...(input.imageUrl && { imageUrl: input.imageUrl }),
			...(input.imageHash && { imageHash: input.imageHash }),
			...(input.marketplace && { marketplace: input.marketplace }),
			...spreadProvenance(input),
		},
	};
}

export function createUnlistPayload(
	nftId: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): ProtocolPayload<UnlistData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_UNLIST,
		data: {
			nftId,
			...(imageUrl && { imageUrl }),
			...(imageHash && { imageHash }),
			...spreadProvenance(provenance),
		},
	};
}

export function createBuyPayload(data: BuyData): ProtocolPayload<BuyData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_BUY,
		data,
	};
}

export function createBuyOperation(data: BuyData, nodeAccount: string): HiveOperation {
	return [
		"custom_json",
		{
			required_auths: [nodeAccount],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(createBuyPayload(data)),
		},
	];
}

// ============ HIVE OPERATION CREATION ============

export async function createReplicateOperation(input: ReplicateInput): Promise<HiveOperation> {
	const payload = await createReplicatePayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [input.currentOwner],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
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
	return [
		"custom_json",
		{
			required_auths: [from],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createBurnOperation(
	nftId: string,
	owner: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): HiveOperation {
	const payload = createBurnPayload(nftId, imageUrl, imageHash, provenance);
	return [
		"custom_json",
		{
			required_auths: [owner],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createListOperation(
	input: ListInput,
	owner: string,
	listingId: string,
	listingNonce: string,
): HiveOperation {
	const payload = createListPayload(input, listingId, listingNonce);
	return [
		"custom_json",
		{
			required_auths: [owner],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createUnlistOperation(
	nftId: string,
	owner: string,
	imageUrl?: string,
	imageHash?: string,
	provenance?: SeedProvenance,
): HiveOperation {
	const payload = createUnlistPayload(nftId, imageUrl, imageHash, provenance);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

// ============ ATOMIC TRANSFER (DUAL-REGISTRO) ============

export function buildTransferMemo(data: TransferMemo): string {
	return `nftlox:${data.action}:${data.nftId}:${data.collectionId}:${data.edition}:${data.instanceDna}`;
}

const VALID_MEMO_ACTIONS = new Set<TransferMemo["action"]>(["transfer", "mint", "sale", "burn", "replicate"]);

export function parseTransferMemo(memo: string): TransferMemo | null {
	const parts = memo.split(":");
	if (parts.length < 6 || parts[0] !== "nftlox") {
		return null;
	}

	const action = parts[1];
	const nftId = parts[2];
	const collectionId = parts[3];
	const editionStr = parts[4];
	const instanceDna = parts[5];

	if (!action || !nftId || !collectionId || !editionStr || !instanceDna) {
		return null;
	}

	if (!VALID_MEMO_ACTIONS.has(action as TransferMemo["action"])) {
		return null;
	}

	const edition = parseInt(editionStr, 10);
	if (isNaN(edition)) {
		return null;
	}

	return {
		action: action as TransferMemo["action"],
		nftId,
		collectionId,
		edition,
		instanceDna,
	};
}

export function createAtomicTransferOperations(
	input: AtomicTransferInput,
): AtomicOperation[] {
	const memo =
		input.memo ||
		buildTransferMemo({
			action: "transfer",
			nftId: input.nftId,
			collectionId: input.collectionId,
			edition: input.edition,
			instanceDna: input.instanceDna,
		});

	const hiveTransfer: HiveTransferOperation = [
		"transfer",
		{
			from: input.from,
			to: input.to,
			amount: ATOMIC_TRACKING_AMOUNT,
			memo: memo,
		},
	];

	// Active key required for atomicity with the transfer above
	const payload = createTransferPayload(
		input.nftId,
		input.from,
		input.to,
		input.imageUrl,
		input.imageHash,
		input,
	);
	const customJson: HiveOperation = [
		"custom_json",
		{
			required_auths: [input.from],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];

	return [hiveTransfer, customJson];
}

export function getTrackingAmount(): string {
	return ATOMIC_TRACKING_AMOUNT;
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

	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_CREATE_COLLECTION,
		data: {
			id,
			name: input.name,
			symbol: input.symbol.toUpperCase(),
			creator: input.creator,
			totalPotential: input.totalPotential,
			originDna,
			metadata: input.metadata,
			rules: input.rules,
			...(input.schema && { schema: input.schema }),
		},
	};
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
	const uniqueAccessKey = await generateAccessKey(instanceDna, input.owner);

	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_MINT,
		data: {
			id: seedId,
			collectionId: input.collectionId,
			edition: input.edition,
			owner: input.owner,
			originDna: input.collectionOriginDna,
			instanceDna,
			uniqueAccessKey,
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
		},
	};
}

export async function createDeterministicMintOperation(
	input: DeterministicMintInput,
): Promise<HiveOperation> {
	const payload = await createDeterministicMintPayload(input);
	return toHiveOperation(payload, input.owner);
}

// ============ PACK PAYLOADS ============

export async function createPackCreatePayload(
	input: PackCreateInput,
	creator: string,
): Promise<ProtocolPayload<PackCreateData>> {
	const id = await generateDeterministicPackId(input.collectionId, input.name);
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_PACK_CREATE,
		data: {
			id,
			collectionId: input.collectionId,
			name: input.name,
			...(input.description && { description: input.description }),
			...(input.imageUrl && { imageUrl: input.imageUrl }),
			dropTable: input.dropTable,
			itemsPerPack: input.itemsPerPack,
			...(input.price && { price: input.price }),
			maxSupply: input.maxSupply,
		},
	};
}

export function createPackBuyPayload(
	input: PackBuyInput,
): ProtocolPayload<PackBuyData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_PACK_BUY,
		data: {
			packId: input.packId,
			quantity: input.quantity,
		},
	};
}

export function createPackTransferPayload(
	input: PackTransferInput,
): ProtocolPayload<PackTransferData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_PACK_TRANSFER,
		data: {
			packId: input.packId,
			to: input.to,
			quantity: input.quantity,
		},
	};
}

export function createPackOpenPayload(
	input: PackOpenInput,
): ProtocolPayload<PackOpenData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_PACK_OPEN,
		data: {
			packId: input.packId,
			quantity: input.quantity,
		},
	};
}

// ============ PACK HIVE OPERATIONS ============

export async function createPackCreateOperation(
	input: PackCreateInput,
	creator: string,
): Promise<HiveOperation> {
	const payload = await createPackCreatePayload(input, creator);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [creator],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createPackBuyOperation(
	input: PackBuyInput,
	buyer: string,
): HiveOperation {
	const payload = createPackBuyPayload(input);
	return [
		"custom_json",
		{
			required_auths: [buyer],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createPackTransferOperation(
	input: PackTransferInput,
	from: string,
): HiveOperation {
	const payload = createPackTransferPayload(input);
	return [
		"custom_json",
		{
			required_auths: [from],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createPackOpenOperation(
	input: PackOpenInput,
	opener: string,
): HiveOperation {
	const payload = createPackOpenPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [opener],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

// ============ APPROVE & TRANSFER_FROM PAYLOADS ============

export function createPackApprovePayload(
	input: PackApproveInput,
): ProtocolPayload<PackApproveData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_PACK_APPROVE,
		data: {
			spender: input.spender,
			packId: input.packId,
			quantity: input.quantity,
			approved: input.approved,
		},
	};
}

export function createPackTransferFromPayload(
	input: PackTransferFromInput,
): ProtocolPayload<PackTransferFromData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_PACK_TRANSFER_FROM,
		data: {
			from: input.from,
			to: input.to,
			packId: input.packId,
			quantity: input.quantity,
		},
	};
}

export function createNftApprovePayload(
	input: NftApproveInput,
): ProtocolPayload<NftApproveData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_NFT_APPROVE,
		data: {
			spender: input.spender,
			instanceId: input.instanceId,
			approved: input.approved,
		},
	};
}

export function createNftApproveAllPayload(
	input: NftApproveAllInput,
): ProtocolPayload<NftApproveAllData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_NFT_APPROVE_ALL,
		data: {
			spender: input.spender,
			collectionId: input.collectionId,
			approved: input.approved,
		},
	};
}

export function createNftTransferFromPayload(
	input: NftTransferFromInput,
): ProtocolPayload<NftTransferFromData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_NFT_TRANSFER_FROM,
		data: {
			from: input.from,
			to: input.to,
			instanceId: input.instanceId,
			...spreadProvenance(input),
		},
	};
}

// ============ APPROVE & TRANSFER_FROM OPERATIONS ============
// Approve operations require active key; transfer_from uses posting (gate was at approve)

export function createPackApproveOperation(
	input: PackApproveInput,
	owner: string,
): HiveOperation {
	const payload = createPackApprovePayload(input);
	return [
		"custom_json",
		{
			required_auths: [owner],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createPackTransferFromOperation(
	input: PackTransferFromInput,
	spender: string,
): HiveOperation {
	const payload = createPackTransferFromPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [spender],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createNftApproveOperation(
	input: NftApproveInput,
	owner: string,
): HiveOperation {
	const payload = createNftApprovePayload(input);
	return [
		"custom_json",
		{
			required_auths: [owner],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createNftApproveAllOperation(
	input: NftApproveAllInput,
	owner: string,
): HiveOperation {
	const payload = createNftApproveAllPayload(input);
	return [
		"custom_json",
		{
			required_auths: [owner],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createNftTransferFromOperation(
	input: NftTransferFromInput,
	spender: string,
): HiveOperation {
	const payload = createNftTransferFromPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [spender],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

// ============ LENDING PAYLOADS & OPERATIONS ============

export function createNftLendPayload(
	input: NftLendInput,
): ProtocolPayload<NftLendData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_NFT_LEND,
		data: {
			instanceId: input.instanceId,
			borrower: input.borrower,
			...spreadProvenance(input),
		},
	};
}

export function createNftReturnPayload(
	input: NftReturnInput,
): ProtocolPayload<NftReturnData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_NFT_RETURN,
		data: {
			instanceId: input.instanceId,
			...spreadProvenance(input),
		},
	};
}

export function createNftLendOperation(
	input: NftLendInput,
	owner: string,
): HiveOperation {
	const payload = createNftLendPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}

export function createNftReturnOperation(
	input: NftReturnInput,
	signer: string,
): HiveOperation {
	const payload = createNftReturnPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [signer],
			id: PROTOCOL_ID,
			json: safeStringify(payload),
		},
	];
}
