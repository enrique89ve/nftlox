// NFTLox Protocol Types - v0.2.1

import type { ProtocolAction, SupportedCurrency } from "./constants";

// ============ HIVE OPERATION TYPES ============

export type HiveOperation = [
	"custom_json",
	{
		required_auths: string[];
		required_posting_auths: string[];
		id: string;
		json: string;
	},
];

// ============ PRICE TYPE ============

export interface Price {
	amount: string;
	currency: SupportedCurrency;
}

// ============ COLLECTION TYPES (Arquetipo) ============

export interface CollectionMetadata {
	description: string;
	image: string;
	externalUrl?: string;
}

export interface CollectionRules {
	transferable: boolean;
	burnable: boolean;
	royaltyPct: number;
	royaltyRecipient?: string;
}

export interface CollectionData {
	id: string;
	jsonId: string;
	name: string;
	symbol: string;
	creator: string;
	totalPotential: number;
	originDna: string;
	metadata: CollectionMetadata;
	rules: CollectionRules;
	createdAt: number;
}

// ============ NFT TYPES (Copia Despertada) ============

export interface NFTMetadata {
	name: string;
	description?: string;
	imageUrl: string;
	imageHash: string;
}

export interface NFTData {
	id: string;
	collectionId: string;
	edition: number;
	owner: string;

	// Identidad (inmutable)
	originDna: string;
	instanceDna: string;
	uniqueAccessKey: string;

	// Procedencia (inmutable)
	birthBlock: number;
	birthTx: string;
	mintedBy: string;

	metadata: NFTMetadata;
	maxReplicas: number;
	createdAt: number;

	// Discovery (optional)
	tags?: string[];
	data?: Record<string, unknown>;
}

// ============ REPLICA TYPES ============

export interface ReplicaData {
	id: string;
	originalId: string;
	newOwner: string;
	originDna: string;
	instanceDna: string;
	uniqueAccessKey: string;
}

// ============ DISTRIBUTE TYPES (Seed → Instance) ============

export interface DistributeData {
	seedId: string;
	instanceId: string;
	to: string;
	instanceNumber: number;
	imageUrl?: string;
	imageHash?: string;
	tags?: string[];
	data?: Record<string, unknown>;
}

export interface DistributeInput {
	seedId: string;
	to: string;
	instanceNumber: number;
	imageUrl?: string;
	imageHash?: string;
	tags?: string[];
	data?: Record<string, unknown>;
}

// ============ TRANSFER & BURN TYPES ============

export interface TransferData {
	nftId: string;
	from: string;
	to: string;
	imageUrl?: string;
	imageHash?: string;
}

export interface BurnData {
	nftId: string;
	imageUrl?: string;
	imageHash?: string;
}

// ============ SET_DATA TYPES ============

export interface SetDataData {
	nftId: string;
	data: Record<string, unknown>;
	tags?: string[];
}

export interface SetDataInput {
	nftId: string;
	data: Record<string, unknown>;
	tags?: string[];
}

// ============ ATOMIC TRANSFER TYPES (Dual-registro) ============

export type TransferMemoAction = "transfer" | "mint" | "sale" | "burn" | "replicate";

export interface TransferMemo {
	action: TransferMemoAction;
	nftId: string;
	collectionId: string;
	edition: number;
	instanceDna: string;
}

export interface AtomicTransferInput {
	nftId: string;
	collectionId: string;
	edition: number;
	instanceDna: string;
	from: string;
	to: string;
	memo?: string;
	imageUrl?: string;
	imageHash?: string;
}

// ============ HIVE TRANSFER OPERATION TYPE ============

export type HiveTransferOperation = [
	"transfer",
	{
		from: string;
		to: string;
		amount: string;
		memo: string;
	},
];

export type AtomicOperation = HiveTransferOperation | HiveOperation;

// ============ MARKETPLACE TYPES ============

export interface ListingData {
	nftId: string;
	price: Price;
	expiresAt?: number;
	imageUrl?: string;
	imageHash?: string;
}

export interface UnlistData {
	nftId: string;
	imageUrl?: string;
	imageHash?: string;
}

export interface BuyData {
	nftId: string;
	paymentTxId: string;
	imageUrl?: string;
	imageHash?: string;
}

export interface OfferData {
	nftId: string;
	price: Price;
	expiresAt?: number;
}

export interface AcceptOfferData {
	nftId: string;
	offerId: string;
	paymentTxId: string;
}

export interface RejectOfferData {
	nftId: string;
	offerId: string;
}

// ============ HISTORY EVENT (Indexador) ============

export type HistoryEventType =
	| "mint"
	| "transfer"
	| "sale"
	| "list"
	| "unlist"
	| "burn"
	| "replicate"
	| "offer"
	| "offer_accepted"
	| "offer_rejected"
	| "set_data";

export interface HistoryEvent {
	id: string;
	nftId: string;
	eventType: HistoryEventType;
	block: number;
	txId: string;
	timestamp: number;
	from?: string;
	to?: string;
	price?: Price;
}

// ============ PROTOCOL PAYLOAD ============

export interface ProtocolPayload<T = unknown> {
	protocol: string;
	version: string;
	action: ProtocolAction;
	data: T;
}

// ============ INPUT TYPES (for payload creation) ============

export interface CreateCollectionInput {
	jsonId: string;
	name: string;
	symbol: string;
	creator: string;
	totalPotential: number;
	metadata: CollectionMetadata;
	rules: CollectionRules;
}

export interface MintInput {
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
	tags?: string[];
	data?: Record<string, unknown>;
}

export interface ReplicateInput {
	originalId: string;
	originDna: string;
	originalInstanceDna: string;
	newOwner: string;
	currentOwner: string;
}

export interface ListInput {
	nftId: string;
	price: Price;
	expiresAt?: number;
	imageUrl?: string;
	imageHash?: string;
}

export interface BuyInput {
	nftId: string;
	paymentTxId: string;
	imageUrl?: string;
	imageHash?: string;
}

export interface BurnInput {
	nftId: string;
	imageUrl?: string;
	imageHash?: string;
}

export interface UnlistInput {
	nftId: string;
	imageUrl?: string;
	imageHash?: string;
}

export interface OfferInput {
	nftId: string;
	price: Price;
	expiresAt?: number;
}

export interface AcceptOfferInput {
	nftId: string;
	offerId: string;
	paymentTxId: string;
}

export interface RejectOfferInput {
	nftId: string;
	offerId: string;
}

// ============ IMPORTED NFT (Batch Import) ============

export interface ImportedNFT {
	nftId: string;
	name: string;
	brief?: string;
	imageUrl: string;
	imageHash?: string;
	maxReplicas?: number;
}

// ============ OWNERSHIP RECORD (Procedencia) ============

export interface OwnershipRecord {
	owner: string;
	acquiredAt: number;
	acquiredFrom: string | null;
	price?: Price;
	txHash: string;
	block: number;
}

// ============ SEED NFT WITH ART ID (Anti-Duplication) ============

/**
 * SeedNFT with mandatory artId for deterministic ID generation.
 * The artId is user-provided and must be unique within a collection.
 */
export interface SeedNFTWithArtId {
	artId: string;
	name: string;
	brief?: string;
	imageUrl: string;
	maxSupply: number;
}

/**
 * Result of pre-mint validation.
 */
export interface PreMintValidationResult {
	valid: boolean;
	stage?: "format" | "uniqueness" | "blockchain";
	collectionId?: string;
	collectionExists?: boolean;
	summary?: {
		total: number;
		new: number;
		existing: number;
	};
	seeds?: Array<{
		artId: string;
		seedId: string;
		exists: boolean;
		name: string;
	}>;
	formatErrors?: Array<{
		index: number;
		artId: string;
		error: string;
	}>;
	duplicates?: string[];
	canProceed?: boolean;
}

/**
 * Minting session for localStorage persistence.
 */
export interface MintingSession {
	id: string;
	status: "validating" | "validated" | "collection_pending" | "seeds_partial" | "complete";
	creator: string;
	collectionName: string;
	collectionSymbol: string;
	nfts: SeedNFTWithArtId[];
	collectionId: string;
	seedMapping: Array<{
		artId: string;
		seedId: string;
		status: "new" | "exists" | "error";
	}>;
	collectionBroadcast: {
		status: "pending" | "broadcast" | "confirmed";
		txId?: string;
	};
	seedBatches: Array<{
		batchNumber: number;
		status: "pending" | "broadcast" | "confirmed";
		seedIds: string[];
		txId?: string;
	}>;
	createdAt: number;
	validatedAt?: number;
	completedAt?: number;
}
