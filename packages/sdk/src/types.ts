// NFTLox Protocol Types - v0.3.0

import type { ProtocolAction, SupportedCurrency } from "./constants";
export type * from "./schemas";

// ============ HIVE OPERATION TYPES ============

export interface ValidationError {
	field: string;
	message: string;
	code: string;
}

export type BuildResult<T> =
	| { success: true; payload: ProtocolPayload<T>; operation?: HiveOperation; hiveOperations?: AtomicOperation[]; warnings?: string[]; generatedId?: string; generatedIds?: Record<string, string> }
	| { success: false; errors: ValidationError[] };

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

// ============ SCHEMA TYPES ============

export type SchemaFieldType =
	| "string" | "bool"
	| "uint8" | "uint16" | "uint32" | "uint64"
	| "int8" | "int16" | "int32" | "int64"
	| "float" | "double"
	| "string[]" | "bool[]"
	| "uint8[]" | "uint16[]" | "uint32[]" | "uint64[]"
	| "int8[]" | "int16[]" | "int32[]" | "int64[]"
	| "float[]" | "double[]";

export type SchemaField = {
	readonly name: string;
	readonly type: SchemaFieldType;
};

export type CollectionSchema = {
	readonly immutable: readonly SchemaField[];
	readonly mutable: readonly SchemaField[];
};

// ============ COLLECTION TYPES (Arquetipo) ============

export interface CollectionMetadata {
	description: string;
	image: string;
	externalUrl?: string;
}

export interface CollectionRules {
	transferable: boolean;
	burnable: boolean;
	replicable: boolean;
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
	schema?: CollectionSchema;
	createdAt: number;
}

// ============ EXTEND SCHEMA TYPES ============

export type ExtendSchemaData = {
	readonly collectionId: string;
	readonly newImmutableFields?: readonly SchemaField[];
	readonly newMutableFields?: readonly SchemaField[];
};

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
	collectionBlock?: number;

	metadata: NFTMetadata;
	maxReplicas: number;
	createdAt: number;

	// Structured data (schema-based collections)
	immutableData?: Record<string, unknown>;
	mutableData?: Record<string, unknown>;
	ownerData?: Record<string, unknown>;

	// Legacy (optional)
	data?: Record<string, unknown>;
}

// ============ REPLICA TYPES ============

export interface ReplicaData extends SeedProvenance {
	id: string;
	originalId: string;
	newOwner: string;
	originDna: string;
	instanceDna: string;
	uniqueAccessKey: string;
}

// ============ BULK DISTRIBUTE TYPES ============

export interface BulkDistributeItem {
	seedId: string;
	quantity: number;
	originBlock: number;
}

export interface BulkDistributeData {
	to?: string;
	items: BulkDistributeItem[];
	imageOverrides?: Record<string, { imageUrl?: string; imageHash?: string }>;
	data?: Record<string, unknown>;
	mutableData?: Record<string, unknown>;
}

// ============ SEED PROVENANCE (for on-chain traceability without indexer) ============

export interface SeedProvenance {
	seedId?: string;
	birthTx?: string;
}

// ============ TRANSFER & BURN TYPES ============

export interface TransferData extends SeedProvenance {
	nftId: string;
	from: string;
	to: string;
	imageUrl?: string;
	imageHash?: string;
}

export interface BurnData extends SeedProvenance {
	nftId: string;
	imageUrl?: string;
	imageHash?: string;
}

// ============ SET_DATA TYPES ============

export interface SetDataData {
	nftId: string;
	instanceDna: string;
	data?: Record<string, unknown>;
	mutableData?: Record<string, unknown>;
}

// ============ SET_OWNER_DATA TYPES ============

export interface SetOwnerDataData {
	nftId: string;
	instanceDna: string;
	data: Record<string, unknown>;
}

// ============ DATA OPERATOR TYPES ============

export interface DataOperatorApproveData {
	collectionId: string;
	operator: string;
	approved: boolean;
}

export interface SetDataFromData extends SeedProvenance {
	nftId: string;
	instanceDna: string;
	data?: Record<string, unknown>;
	mutableData?: Record<string, unknown>;
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

export interface ListingData extends SeedProvenance {
	nftId: string;
	listingId: string;
	listingNonce: string;
	price: Price;
	expiresAt?: number;
	imageUrl?: string;
	imageHash?: string;
	marketplace?: string;
}

export interface UnlistData {
	nftId: string;
	imageUrl?: string;
	imageHash?: string;
}

export type BuyData = {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
};

// ============ PACK TYPES (Semi-Fungible) ============

export interface PackDropEntry {
	seedId: string;
	weight: number;
}

export interface PackCreateData {
	id: string;
	collectionId: string;
	name: string;
	description?: string;
	imageUrl?: string;
	dropTable: PackDropEntry[];
	itemsPerPack: number;
	price?: Price;
	maxSupply: number;
	createdAt: number;
}

export interface PackBuyData {
	packId: string;
	quantity: number;
}

export interface PackTransferData {
	packId: string;
	to: string;
	quantity: number;
}

export interface PackOpenData {
	packId: string;
	quantity: number;
}

// ============ APPROVE & TRANSFER_FROM TYPES ============

export interface PackApproveData {
	spender: string;
	packId: string;
	quantity: number;
	approved: boolean;
}

export interface PackTransferFromData {
	from: string;
	to: string;
	packId: string;
	quantity: number;
}

export interface NftApproveData {
	spender: string;
	instanceId: string;
	approved: boolean;
}

export interface NftApproveAllData {
	spender: string;
	collectionId: string;
	approved: boolean;
}

export interface NftTransferFromData extends SeedProvenance {
	from: string;
	to: string;
	instanceId: string;
}

// ============ LENDING TYPES ============

export interface NftLendData extends SeedProvenance {
	instanceId: string;
	borrower: string;
}

export interface NftReturnData extends SeedProvenance {
	instanceId: string;
}

// ============ DATA TRACKING (blockchain provenance) ============

export type DataProof = {
	readonly hash: string;
	readonly txId: string;
	readonly blockNum: number;
};

// ============ PROTOCOL PAYLOAD ============

export interface ProtocolPayload<T = unknown> {
	protocol: string;
	version: string;
	action: ProtocolAction;
	data: T;
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

// ============ MULTISIG TYPES ============

export type HiveTransactionObject = Readonly<{
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
	operations: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	extensions: ReadonlyArray<unknown>;
	signatures: ReadonlyArray<string>;
}>;

export type MultisigErrorCode =
	| "RATE_LIMITED"
	| "INVALID_TX_STRUCTURE"
	| "NFT_NOT_FOUND"
	| "NFT_NOT_LISTED"
	| "NFT_EXPIRED_LISTING"
	| "CANNOT_BUY_OWN"
	| "INVALID_PAYMENT_SPLIT"
	| "INVALID_PROTOCOL_PAYLOAD"
	| "NODE_ACCOUNT_MISMATCH"
	| "MISSING_BUYER_AUTH"
	| "MULTISIG_DISABLED"
	| "INTERNAL_ERROR";

export type MultisigResponse =
	| Readonly<{ ok: true; signature: string; digest: string; expiration: string }>
	| Readonly<{ ok: false; code: MultisigErrorCode; message: string }>;

export type MultisigRequest = Readonly<{
	buyer: string;
	nftId: string;
	listingId: string;
	listTxId: string;
	transaction: HiveTransactionObject;
}>;

export type PaymentInfo = Readonly<{
	nftId: string;
	listingId: string;
	listTxId: string;
	seller: string;
	totalPrice: number;
	currency: string;
	sellerAmount: number;
	royaltyAmount: number;
	royaltyRecipient: string | null;
	feeAmount: number;
	feeAccount: string;
	nodeAccount: string;
}>;
