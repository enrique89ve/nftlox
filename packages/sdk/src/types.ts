// NFTLox Protocol Types

import type { ProtocolAction, SupportedCurrency } from "./constants";
export type * from "./schemas";

// ============ HIVE OPERATION TYPES ============

export interface ValidationError {
	field: string;
	message: string;
	code: string;
}

export type BuildResult<T> =
	| { success: true; payload: ProtocolPayload<T>; operation?: HiveOperation; hiveOperations?: Array<HiveOperation | HiveTransferOperation>; warnings?: string[]; generatedId?: string; generatedIds?: Record<string, string> }
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
	/** Hive asset amount encoded with exactly 3 decimal places, for example "1.000". */
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
	/** Royalty percentage as a whole percent value in protocol 0.5.x. Example: 5 = 5%. */
	royaltyPct: number;
	royaltyRecipient?: string;
}

export interface CollectionData {
	id: string;
	name: string;
	symbol: string;
	creator: string;
	totalPotential: number;
	originDna: string;
	metadata: CollectionMetadata;
	rules: CollectionRules;
	schema?: CollectionSchema;
}

export interface ArchiveCollectionData {
	collectionId: string;
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
	nftType?: "seed" | "instance";

	// Identidad (inmutable)
	originDna: string;
	instanceDna: string;
	uniqueAccessKey?: string;

	// Procedencia (inmutable — tx_id y block_num del NFT)
	mintedBy: string;
	collectionBlock?: number;

	metadata: NFTMetadata;
	maxSupply: number;

	// Structured data (schema-based collections)
	immutableData?: Record<string, unknown>;
	mutableData?: Record<string, unknown>;

	// Legacy (optional)
	data?: Record<string, unknown>;
}

// ============ BULK DISTRIBUTE TYPES ============

export interface BulkDistributeItem {
	seedId: string;
	quantity: number;
	/** The seed's tx_id. Validated by the indexer against the seed's actual tx_id. */
	seedTxId: string;
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
	/** The seed parent's tx_id — for L1 traceability without indexer. */
	seedTxId?: string;
}

// ============ TRANSFER TYPES ============
// Burn = transfer to "null". No separate burn action.

export interface TransferData extends SeedProvenance {
	nftId?: string;
	nftIds?: string[];
	from: string;
	to: string;
	imageUrl?: string;
	imageHash?: string;
}

// ============ SET_DATA TYPES ============

export interface SetDataData {
	nftId: string;
	instanceDna: string;
	data?: Record<string, unknown>;
	mutableData?: Record<string, unknown>;
	seedId?: string;
	seedTxId?: string;
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
	seedId?: string;
	seedTxId?: string;
}

export interface BuyData {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly txId: string;
	readonly seedId?: string;
	readonly seedTxId?: string;
}

// ============ APPROVE & TRANSFER_FROM TYPES ============

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

// ============ PROTOCOL PAYLOAD ============

export interface ProtocolPayload<T = unknown> {
	readonly protocol: string;
	readonly version: string;
	readonly action: ProtocolAction;
	readonly data: T;
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
	| "NFT_LOCKED"
	| "RATE_LIMITED"
	| "INVALID_TX_STRUCTURE"
	| "NFT_NOT_FOUND"
	| "NFT_NOT_LISTED"
	| "NFT_NOT_INSTANCE"
	| "NFT_NOT_TRANSFERABLE"
	| "NFT_EXPIRED_LISTING"
	| "CANNOT_BUY_OWN"
	| "SEED_HAS_INSTANCES"
	| "INVALID_PAYMENT_SPLIT"
	| "INVALID_PROTOCOL_PAYLOAD"
	| "NODE_ACCOUNT_MISMATCH"
	| "MISSING_BUYER_AUTH"
	| "MULTISIG_DISABLED"
	| "POW_REQUIRED"
	| "INVALID_POW"
	| "POW_EXPIRED"
	| "POW_REPLAYED"
	| "SIGNING_QUEUE_FULL"
	| "SIGNING_TIMEOUT"
	| "INTERNAL_ERROR";

export type MultisigResponse =
	| Readonly<{ ok: true; signature: string; digest: string; expiration: string }>
	| Readonly<{ ok: false; code: MultisigErrorCode; message: string }>;

export type BuyMultisigRequest = Readonly<{
	buyer: string;
	nftId: string;
	listingId: string;
	listTxId: string;
	transaction: HiveTransactionObject;
}>;

export type CreateCollectionMultisigRequest = Readonly<{
	creator: string;
	transaction: HiveTransactionObject;
}>;

export type MultisigRequest = BuyMultisigRequest | CreateCollectionMultisigRequest;

export type PaymentInfo = Readonly<{
	nftId: string;
	listingId: string;
	listTxId: string;
	seller: string;
	/** Decimal Hive asset value rounded to 3 decimals. */
	totalPrice: number;
	currency: string;
	/** Decimal Hive asset value rounded to 3 decimals. */
	sellerAmount: number;
	/** Decimal Hive asset value rounded to 3 decimals. */
	royaltyAmount: number;
	royaltyRecipient: string | null;
	/** Decimal Hive asset value rounded to 3 decimals. */
	feeAmount: number;
	feeAccount: string;
	nodeAccount: string;
	txId: string;
	seedTxId: string | null;
}>;

export interface NodeRegisterData {
	endpoint: string;
	publicKey: string;
}
