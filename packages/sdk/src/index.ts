// @nftlox/sdk — NFTLox Protocol SDK
// Public API: re-exports the wire protocol from @nftlox/protocol and adds
// the SDK-only builders, clients, SPV verifiers, and persistence helpers.

// ============ PROTOCOL (re-exported from @nftlox/protocol) ============
export {
	// Constants
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	MIN_PROTOCOL_VERSION,
	HASH_VERSION,
	MAX_JSON_SIZE,
	MAX_OPERATIONS_PER_TX,
	TX_DELAY_MS,
	MAX_NAME_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	MAX_URL_LENGTH,
	MAX_ID_LENGTH,
	MIN_SYMBOL_LENGTH,
	MAX_SYMBOL_LENGTH,
	SYMBOL_REGEX,
	TX_ID_REGEX,
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACCESS_KEY_LENGTH,
	INSTANCE_ID_HASH_LENGTH,
	HIVE_CUSTOM_JSON_MAX_BYTES,
	SAFE_PAYLOAD_MAX_BYTES,
	MAX_BULK_DISTRIBUTE_ITEMS,
	MAX_TRANSFER_BATCH_SIZE,
	MAX_SCHEMA_FIELDS,
	MAX_FIELD_NAME_LENGTH,
	SUPPORTED_CURRENCIES,
	MAX_ROYALTY_PCT,
	MIN_PRICE_AMOUNT,
	BASIS_POINTS_DENOMINATOR,
	PROTOCOL_FEE_BPS,
	DEFAULT_FEE_ACCOUNT,
	PROTOCOL_COLLECTION_FEE_HBD,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	LISTING_ID_PREFIX,
	LISTING_NONCE_LENGTH,
	LISTING_HASH_LENGTH,
	MULTISIG_EXPIRATION_MS,
	MAX_MULTISIG_OPERATIONS,
	// Actions
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_NODE_REGISTER,
	ACTION_NODE_HEARTBEAT,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
	ALL_ACTIONS,
	CORE_ACTIONS,
	MARKETPLACE_ACTIONS,
	APPROVE_ACTIONS,
	LENDING_ACTIONS,
	DATA_OPERATOR_ACTIONS,
	ACTIVE_AUTH_ACTIONS,
	POSTING_AUTH_ACTIONS,
	ACTION_AUTH_LEVEL,
	// Auth
	isProtocolAction,
	getAuthLevel,
	getKeyType,
	getAuthMismatchReason,
	// Payment
	calculatePaymentSplit,
	calculateBasisPointsAmount,
	percentageToBasisPoints,
	roundHive,
	// Username
	validateHiveUsername,
	// Payload
	createPayload,
	createHiveOperation,
	PayloadTooLargeError,
	// Schema
	canonicalJson,
	computeDataHash,
	VALID_SCHEMA_TYPES,
	validateValueAgainstType,
	validateSchemaDefinition,
	validateMintData,
	validateMutableUpdate,
	validateMutableSnapshot,
	mergeSchemas,
	// DNA
	generateHash,
	generateOriginDna,
	generateInstanceDna,
	generateImageHash,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
	generateInstanceId,
	extractSeedId,
	extractInstanceNumber,
	isSeedId,
	isInstanceId,
	generateListingNonce,
	generateListingId,
	// Types
	type ProtocolAction,
	type AuthLevel,
	type KeyType,
	type ActiveAuthAction,
	type PostingAuthAction,
	type CoreAction,
	type MarketplaceAction,
	type ApproveAction,
	type LendingAction,
	type DataOperatorAction,
	type SupportedCurrency,
	type ProtocolPayload,
	type HiveOperation,
	type HiveTransferOperation,
	type HiveTransactionObject,
	type HiveCustomJsonBody,
	type HiveTransferBody,
	type Price,
	type PaymentSplit,
	type SeedProvenance,
	type SchemaFieldType,
	type SchemaField,
	type CollectionSchema,
	type CreatePayloadOptions,
	// Action-data types
	type CollectionMetadata,
	type CollectionRules,
	type CollectionData,
	type ArchiveCollectionData,
	type ExtendSchemaData,
	type NFTMetadata,
	type NFTData,
	type BulkDistributeItem,
	type BulkDistributeData,
	type TransferData,
	type SetDataData,
	type SetDataFromData,
	type DataOperatorApproveData,
	type ListingData,
	type UnlistData,
	type BuyData,
	type NftApproveData,
	type NftApproveAllData,
	type NftTransferFromData,
	type NftLendData,
	type NftReturnData,
	type NodeRegisterData,
	type NodeHeartbeatData,
	// Multisig
	type BuyMultisigRequest,
	type CreateCollectionMultisigRequest,
	type MultisigRequest,
	type MultisigErrorCode,
	type MultisigResponse,
	type PaymentInfo,
} from "@nftlox/protocol";

// ============ SDK-ONLY: ART ID ============
export {
	sanitizeArtId,
	generateArtIdFromName,
	validateArtId,
	validateArtIdArray,
	type ArtIdValidationResult,
	type ArtIdArrayValidation,
} from "./artid";

// ============ SDK-ONLY: SESSION TYPES ============
export type { SeedNFTWithArtId, MintingSession } from "./types";

// ============ SDK-ONLY: ZOD SCHEMAS ============
export * from "./schemas";

// ============ SDK-ONLY: BUILDERS ============
export * from "./builders";

// ============ SDK-ONLY: PROTOCOL STATE ============
export { initProtocol, getProtocolVersion, getProtocolId, isInitialized } from "./protocol-state";

// ============ SDK-ONLY: NFT OPERATION PRE-VALIDATION ============
export { validateNftOperation } from "./validate";
export type { NftState, PreValidationResult } from "./validate";

// ============ SDK-ONLY: SCHEMA TEMPLATES ============
export {
	GAMING_SCHEMA,
	ART_SCHEMA,
	COLLECTIBLE_SCHEMA,
	MUSIC_SCHEMA,
	RAGNAROK_MINION_SCHEMA,
	RAGNAROK_SPELL_SCHEMA,
	RAGNAROK_WEAPON_SCHEMA,
	RAGNAROK_PET_SCHEMA,
	RAGNAROK_ARMOR_SCHEMA,
	RAGNAROK_HERO_SCHEMA,
	createSchemaBuilder,
} from "./schema-templates";

// ============ SDK-ONLY: MULTISIG CLIENT ============
export {
	fetchPaymentInfo,
	requestBuyMultisig,
	requestCreateCollectionMultisig,
	type RequestMultisigOptions,
} from "./multisig";

export {
	DEFAULT_MULTISIG_POW_BITS,
	MAX_MULTISIG_POW_BITS,
	MULTISIG_POW_VERSION,
	NFTLOX_POW_HEADER,
	canonicalPowJson,
	hashJsonPayload,
	hashMultisigPowToken,
	hasLeadingZeroBits,
	solveMultisigPow,
} from "./pow";

// ============ SDK-ONLY: SPV VERIFICATION ============
export * from "./spv";

// ============ SDK-ONLY: INHERITANCE ============
export { resolveInstance } from "./inheritance";

// ============ SDK-ONLY: INDEXER CLIENT ============
export {
	createIndexerClient,
	IndexerError,
	type IndexerClient,
	type SyncStatus,
	type HealthStatus,
	type ProtocolStats,
	type IndexerCollection,
	type CollectionStats,
	type IndexerNft,
	type IndexerNftOwner,
	type IndexerNftProof,
	type IndexerNftLoan,
	type IndexerNftLoanStatus,
	type IndexerNftSummary,
	type IndexerOwnershipAction,
	type LoanRole,
	type ListingSort,
	type UserAssetsOverview,
	type UserAssetsQueryParams,
	type UserLoansPage,
	type UserLoansQueryParams,
	type UserNftCounts,
	type UserNftsPage,
	type UserNftsQueryParams,
} from "./client";

// ============ SDK-ONLY: UTILS ============
export * from "./utils/tx-sizing";
