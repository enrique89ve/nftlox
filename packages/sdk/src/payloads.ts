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
	ACTION_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
	ACTION_OFFER,
	ACTION_ACCEPT_OFFER,
	ACTION_REJECT_OFFER,
	MAX_TAGS,
	MAX_TAG_LENGTH,
} from "./constants";

import type {
	CollectionData,
	NFTData,
	ReplicaData,
	TransferData,
	BurnData,
	SetDataData,
	SetDataInput,
	DistributeData,
	DistributeInput,
	ListingData,
	UnlistData,
	BuyData,
	OfferData,
	AcceptOfferData,
	RejectOfferData,
	ProtocolPayload,
	CreateCollectionInput,
	MintInput,
	ReplicateInput,
	ListInput,
	BuyInput,
	BurnInput,
	UnlistInput,
	OfferInput,
	AcceptOfferInput,
	RejectOfferInput,
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
	generateOfferId,
	generateInstanceId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
	deterministicHash,
} from "./dna";

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
		},
	};
}

// ============ DISTRIBUTE PAYLOADS (Seed → Instance) ============

export function createDistributePayload(
	input: DistributeInput,
): ProtocolPayload<DistributeData> {
	const instanceId = generateInstanceId(input.seedId, input.instanceNumber);
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_DISTRIBUTE,
		data: {
			seedId: input.seedId,
			instanceId,
			to: input.to,
			instanceNumber: input.instanceNumber,
			...(input.imageUrl && { imageUrl: input.imageUrl }),
			...(input.imageHash && { imageHash: input.imageHash }),
			...(input.tags && { tags: sanitizeTags(input.tags) }),
			...(input.data && { data: input.data }),
		},
	};
}

// ============ TRANSFER PAYLOADS ============

export function createTransferPayload(
	nftId: string,
	from: string,
	to: string,
	imageUrl?: string,
	imageHash?: string,
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
		},
	};
}

// ============ BURN PAYLOADS ============

export function createBurnPayload(
	nftId: string,
	imageUrl?: string,
	imageHash?: string,
): ProtocolPayload<BurnData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_BURN,
		data: {
			nftId,
			...(imageUrl && { imageUrl }),
			...(imageHash && { imageHash }),
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
 * Only the collection creator (or authorized issuer) should call this.
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
			required_auths: [issuer],
			required_posting_auths: [],
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
			expiresAt: input.expiresAt,
			...(input.imageUrl && { imageUrl: input.imageUrl }),
			...(input.imageHash && { imageHash: input.imageHash }),
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

export function createBuyPayload(input: BuyInput): ProtocolPayload<BuyData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_BUY,
		data: {
			nftId: input.nftId,
			paymentTxId: input.paymentTxId,
			...(input.imageUrl && { imageUrl: input.imageUrl }),
			...(input.imageHash && { imageHash: input.imageHash }),
		},
	};
}

export function createOfferPayload(input: OfferInput): ProtocolPayload<OfferData & { offerId: string }> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_OFFER,
		data: {
			offerId: generateOfferId(),
			nftId: input.nftId,
			price: input.price,
			expiresAt: input.expiresAt,
		},
	};
}

export function createAcceptOfferPayload(
	input: AcceptOfferInput,
): ProtocolPayload<AcceptOfferData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_ACCEPT_OFFER,
		data: {
			nftId: input.nftId,
			offerId: input.offerId,
			paymentTxId: input.paymentTxId,
		},
	};
}

export function createRejectOfferPayload(
	input: RejectOfferInput,
): ProtocolPayload<RejectOfferData> {
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_REJECT_OFFER,
		data: {
			nftId: input.nftId,
			offerId: input.offerId,
		},
	};
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

export function createDistributeOperation(
	input: DistributeInput,
	owner: string,
): HiveOperation {
	const payload = createDistributePayload(input);
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

export function createTransferOperation(
	nftId: string,
	from: string,
	to: string,
	imageUrl?: string,
	imageHash?: string,
): HiveOperation {
	const payload = createTransferPayload(nftId, from, to, imageUrl, imageHash);
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
): HiveOperation {
	const payload = createBurnPayload(nftId, imageUrl, imageHash);
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

export function createBuyOperation(input: BuyInput, buyer: string): HiveOperation {
	const payload = createBuyPayload(input);
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

export function createOfferOperation(input: OfferInput, offerer: string): HiveOperation {
	const payload = createOfferPayload(input);
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [offerer],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];
}

export function createAcceptOfferOperation(
	input: AcceptOfferInput,
	owner: string,
): HiveOperation {
	const payload = createAcceptOfferPayload(input);
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

export function createRejectOfferOperation(
	input: RejectOfferInput,
	owner: string,
): HiveOperation {
	const payload = createRejectOfferPayload(input);
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

/**
 * Creates a distribute payload with a deterministic instanceId.
 * Same seedId + instanceNumber always produces the same instanceId.
 */
export function createDeterministicDistributePayload(
	input: DistributeInput,
): ProtocolPayload<DistributeData> {
	const instanceId = generateDeterministicInstanceId(
		input.seedId,
		input.instanceNumber,
	);
	return {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_DISTRIBUTE,
		data: {
			seedId: input.seedId,
			instanceId,
			to: input.to,
			instanceNumber: input.instanceNumber,
		},
	};
}
