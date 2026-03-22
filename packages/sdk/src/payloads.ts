// NFTLox Payload Creation Module
// Creates JSON payloads for all protocol actions

import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
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
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_BUY,
	MAX_TAGS,
	MAX_TAG_LENGTH,
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
	CreateCollectionInput,
	MintInput,
	ReplicateInput,
	ListInput,
	BurnInput,
	UnlistInput,
	HiveOperation,
	TransferMemo,
	AtomicTransferInput,
	HiveTransferOperation,
	AtomicOperation,
} from "./types";

import {
	generateId,
	generateOriginDnaSync,
	generateInstanceDna,
	generateReplicaInstanceDna,
	generateAccessKey,
	generateImageHash,
	generateReplicaId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicPackId,
	deterministicHash,
} from "./dna";

/** Spread seed provenance fields only when present */
function spreadProvenance(p?: SeedProvenance): Record<string, string> {
	if (!p) return {};
	return {
		...(p.seedId && { seedId: p.seedId }),
		...(p.birthTx && { birthTx: p.birthTx }),
	};
}

// ============ COLLECTION PAYLOADS ============

export function createCollectionPayload(
	input: CreateCollectionInput,
): ProtocolPayload<CollectionData> {
	const id = generateId("col");
	const originDna = generateOriginDnaSync(id);

	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_CREATE_COLLECTION,
		data: {
			id,
			jsonId: input.jsonId,
			name: input.name,
			symbol: input.symbol.toUpperCase(),
			creator: input.creator,
			totalPotential: input.totalPotential,
			originDna,
			metadata: input.metadata,
			rules: input.rules,
			createdAt: Date.now(),
		},
	};
}

// ============ MINT PAYLOADS ============

export function createMintPayload(input: MintInput): ProtocolPayload<NFTData> {
	const imageHash = input.imageHash || generateImageHash(input.imageUrl);
	const instanceDna = generateInstanceDna(
		input.collectionOriginDna,
		input.edition,
		imageHash,
	);
	const uniqueAccessKey = generateAccessKey(instanceDna, input.owner);

	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_MINT,
		data: {
			id: generateId("nft"),
			collectionId: input.collectionId,
			edition: input.edition,
			owner: input.owner,

			// Identidad
			originDna: input.collectionOriginDna,
			instanceDna,
			uniqueAccessKey,

			// Procedencia
			birthBlock: input.birthBlock ?? 0,
			birthTx: input.birthTx ?? "",
			mintedBy: input.owner,

			metadata: {
				name: input.name,
				description: input.description,
				imageUrl: input.imageUrl,
				imageHash,
			},
			maxReplicas: input.maxReplicas ?? 1,
			createdAt: Date.now(),

			// Discovery (optional)
			...(input.tags && { tags: sanitizeTags(input.tags) }),
			...(input.data && { data: input.data }),
		},
	};
}

// ============ REPLICATE PAYLOADS ============

export function createReplicatePayload(
	input: ReplicateInput,
): ProtocolPayload<ReplicaData> {
	const instanceDna = generateReplicaInstanceDna(
		input.originDna,
		input.originalInstanceDna,
	);
	const uniqueAccessKey = generateAccessKey(instanceDna, input.newOwner);

	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_REPLICATE,
		data: {
			id: generateReplicaId(input.originalId),
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
			})),
			...(input.imageOverrides && { imageOverrides: input.imageOverrides }),
			...(input.data && { data: input.data }),
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
			json: JSON.stringify(payload),
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
 * Sanitize tags: lowercase, trim, max 4 tags, max 8 chars each.
 */
export function sanitizeTags(tags: string[]): string[] {
	return tags
		.map((t) => t.trim().toLowerCase().slice(0, MAX_TAG_LENGTH))
		.filter(Boolean)
		.slice(0, MAX_TAGS);
}

/**
 * Create a set_data payload to update an NFT's mutable data and/or tags.
 * Only the NFT owner can call this (requires active key).
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
			data: input.data,
			...(input.tags && { tags: sanitizeTags(input.tags) }),
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
			json: JSON.stringify(payload),
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
			required_auths: [],
			required_posting_auths: [creator],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			data: input.data,
			...(input.tags && { tags: sanitizeTags(input.tags) }),
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
			json: JSON.stringify(payload),
		},
	];
}

// ============ MARKETPLACE PAYLOADS ============

export function createListPayload(input: ListInput): ProtocolPayload<ListingData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_LIST,
		data: {
			nftId: input.nftId,
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
): ProtocolPayload<UnlistData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_UNLIST,
		data: {
			nftId,
			...(imageUrl && { imageUrl }),
			...(imageHash && { imageHash }),
		},
	};
}

export function createBuyPayload(data: BuyData): ProtocolPayload {
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
			json: JSON.stringify(createBuyPayload(data)),
		},
	];
}

// ============ HIVE OPERATION CREATION ============

export function createCollectionOperation(
	input: CreateCollectionInput,
): HiveOperation {
	const payload = createCollectionPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [input.creator],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];
}

export function createMintOperation(input: MintInput): HiveOperation {
	const payload = createMintPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [input.owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];
}

export function createReplicateOperation(input: ReplicateInput): HiveOperation {
	const payload = createReplicatePayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [input.currentOwner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			required_auths: [],
			required_posting_auths: [from],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];
}

export function createListOperation(input: ListInput, owner: string): HiveOperation {
	const payload = createListPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];
}

export function createUnlistOperation(
	nftId: string,
	owner: string,
	imageUrl?: string,
	imageHash?: string,
): HiveOperation {
	const payload = createUnlistPayload(nftId, imageUrl, imageHash);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];
}

// ============ ATOMIC TRANSFER (DUAL-REGISTRO) ============

const TRACKING_AMOUNT = "0.001 HIVE";

export function buildTransferMemo(data: TransferMemo): string {
	return `nftlox:${data.action}:${data.nftId}:${data.collectionId}:${data.edition}:${data.instanceDna}`;
}

export function parseTransferMemo(memo: string): TransferMemo | null {
	const parts = memo.split(":");
	if (parts.length < 6 || parts[0] !== "nftlox") {
		return null;
	}

	const [, action, nftId, collectionId, editionStr, instanceDna] = parts;
	const edition = parseInt(editionStr!, 10);

	if (isNaN(edition)) {
		return null;
	}

	return {
		action: action as TransferMemo["action"],
		nftId: nftId!,
		collectionId: collectionId!,
		edition,
		instanceDna: instanceDna!,
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

	// Operación 1: HIVE transfer (requiere Active key)
	const hiveTransfer: HiveTransferOperation = [
		"transfer",
		{
			from: input.from,
			to: input.to,
			amount: TRACKING_AMOUNT,
			memo: memo,
		},
	];

	// Operación 2: Custom JSON con Active key (para atomicidad con transfer)
	// Usamos required_auths en lugar de required_posting_auths
	// para que ambas operaciones usen Active key y puedan ejecutarse atómicamente
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
			json: JSON.stringify(payload),
		},
	];

	return [hiveTransfer, customJson];
}

export function getTrackingAmount(): string {
	return TRACKING_AMOUNT;
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
		royaltyPct: number;
		royaltyRecipient?: string;
	};
}

/**
 * Creates a collection payload with a deterministic ID.
 * Same creator + name + symbol always produces the same collectionId.
 */
export function createDeterministicCollectionPayload(
	input: DeterministicCollectionInput,
): ProtocolPayload<CollectionData> {
	const id = generateDeterministicCollectionId(
		input.creator,
		input.name,
		input.symbol,
	);
	const originDna = generateOriginDnaSync(id);
	const jsonId = `json_${deterministicHash(`${input.creator}:${input.name}:${Date.now()}`).slice(0, 8)}`;

	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_CREATE_COLLECTION,
		data: {
			id,
			jsonId,
			name: input.name,
			symbol: input.symbol.toUpperCase(),
			creator: input.creator,
			totalPotential: input.totalPotential,
			originDna,
			metadata: input.metadata,
			rules: input.rules,
			createdAt: Date.now(),
		},
	};
}

export interface DeterministicMintInput {
	artId: string;
	collectionId: string;
	collectionOriginDna: string;
	edition: number;
	owner: string;
	name: string;
	description?: string;
	imageUrl: string;
	imageHash?: string;
	maxReplicas?: number;
	birthBlock?: number;
	birthTx?: string;
}

/**
 * Creates a seed mint payload with a deterministic seedId.
 * Same collectionId + artId always produces the same seedId.
 */
export function createDeterministicMintPayload(
	input: DeterministicMintInput,
): ProtocolPayload<NFTData> {
	const seedId = generateDeterministicSeedId(input.collectionId, input.artId);
	const imageHash = input.imageHash || generateImageHash(input.imageUrl);
	const instanceDna = generateInstanceDna(
		input.collectionOriginDna,
		input.edition,
		imageHash,
	);
	const uniqueAccessKey = generateAccessKey(instanceDna, input.owner);

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
			birthBlock: input.birthBlock ?? 0,
			birthTx: input.birthTx ?? "",
			mintedBy: input.owner,
			metadata: {
				name: input.name,
				description: input.description,
				imageUrl: input.imageUrl,
				imageHash,
			},
			maxReplicas: input.maxReplicas ?? 1,
			createdAt: Date.now(),
		},
	};
}

// ============ PACK PAYLOADS ============

export function createPackCreatePayload(
	input: PackCreateInput,
	creator: string,
): ProtocolPayload<PackCreateData> {
	const id = generateDeterministicPackId(input.collectionId, input.name);
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
			createdAt: Date.now(),
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

export function createPackCreateOperation(
	input: PackCreateInput,
	creator: string,
): HiveOperation {
	const payload = createPackCreatePayload(input, creator);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [creator],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			required_auths: [],
			required_posting_auths: [buyer],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			required_auths: [],
			required_posting_auths: [from],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			json: JSON.stringify(payload),
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
// Approve operations use required_auths (active key) for security

export function createPackApproveOperation(
	input: PackApproveInput,
	owner: string,
): HiveOperation {
	const payload = createPackApprovePayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			json: JSON.stringify(payload),
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
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			required_auths: [],
			required_posting_auths: [owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
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
			json: JSON.stringify(payload),
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
			json: JSON.stringify(payload),
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
			json: JSON.stringify(payload),
		},
	];
}
