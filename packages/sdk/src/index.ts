// NFTLox Protocol - Public API
// Typed schemas + data tracking

// ============ CONSTANTS ============
export {
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
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACCESS_KEY_LENGTH,
	INSTANCE_ID_HASH_LENGTH,
	SUPPORTED_CURRENCIES,
	BASIS_POINTS_DENOMINATOR,
	MAX_ROYALTY_PCT,
	MIN_PRICE_AMOUNT,
	PROTOCOL_FEE_BPS,
	DEFAULT_FEE_ACCOUNT,
	PROTOCOL_COLLECTION_FEE_HBD,
	calculatePaymentSplit,
	calculateBasisPointsAmount,
	percentageToBasisPoints,
	roundHive,
	type PaymentSplit,
	HIVE_CUSTOM_JSON_MAX_BYTES,
	SAFE_PAYLOAD_MAX_BYTES,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_BULK_DISTRIBUTE,
	MAX_BULK_DISTRIBUTE_ITEMS,
	MAX_TRANSFER_BATCH_SIZE,
	ACTION_SET_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_NODE_REGISTER,
	MAX_SCHEMA_FIELDS,
	MAX_FIELD_NAME_LENGTH,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
	LISTING_ID_PREFIX,
	LISTING_NONCE_LENGTH,
	LISTING_HASH_LENGTH,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	MULTISIG_EXPIRATION_MS,
	MAX_MULTISIG_OPERATIONS,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
	CORE_ACTIONS,
	MARKETPLACE_ACTIONS,
	APPROVE_ACTIONS,
	LENDING_ACTIONS,
	DATA_OPERATOR_ACTIONS,
	ALL_ACTIONS,
	ACTIVE_AUTH_ACTIONS,
	POSTING_AUTH_ACTIONS,
	ACTION_AUTH_LEVEL,
	getAuthLevel,
	getKeyType,
	isProtocolAction,
	type AuthLevel,
	type ActiveAuthAction,
	type PostingAuthAction,
	type CoreAction,
	type MarketplaceAction,
	type ApproveAction,
	type LendingAction,
	type DataOperatorAction,
	type ProtocolAction,
	type SupportedCurrency,
} from "./constants";

// ============ TYPES ============
export type {
	// Schema types
	SchemaFieldType,
	SchemaField,
	CollectionSchema,
	ExtendSchemaData,
	// Core types
	HiveOperation,
	Price,
	CollectionMetadata,
	CollectionRules,
	CollectionData,
	ArchiveCollectionData,
	NFTMetadata,
	NFTData,
	SeedProvenance,
	BulkDistributeItem,
	BulkDistributeData,
	BulkDistributeInput,
	TransferData,
	SetDataData,
	SetDataInput,
	DataOperatorApproveData,
	DataOperatorApproveInput,
	SetDataFromData,
	SetDataFromInput,
	ListingData,
	UnlistData,
	BuyData,
	HiveTransactionObject,
	MultisigErrorCode,
	MultisigResponse,
	BuyMultisigRequest,
	CreateCollectionMultisigRequest,
	MultisigRequest,
	PaymentInfo,
	ProtocolPayload,
	CreateCollectionInput,
	ArchiveCollectionInput,
	MintInput,
	ListInput,
	BuyInput,
	UnlistInput,
	ImportedNFT,
	HiveTransferOperation,
	// Anti-duplication types
	SeedNFTWithArtId,
	MintingSession,
	// Approve & TransferFrom types
	NftApproveData,
	NftApproveInput,
	NftApproveAllData,
	NftApproveAllInput,
	NftTransferFromData,
	NftTransferFromInput,
	// Lending types
	NftLendData,
	NftLendInput,
	NftReturnData,
	NftReturnInput,
	NodeRegisterData,
	NodeRegisterInput,
} from "./types";

// ============ DNA GENERATION ============
export {
	generateHash,
	generateOriginDna,
	generateInstanceDna,
	generateImageHash,
	// Seed & Instance helpers
	generateInstanceId,
	extractSeedId,
	extractInstanceNumber,
	isSeedId,
	isInstanceId,
	// ArtId validation & sanitization
	sanitizeArtId,
	generateArtIdFromName,
	validateArtId,
	validateArtIdArray,
	type ArtIdValidationResult,
	// Deterministic ID generation (SHA-256)
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
	// Listing ID
	generateListingNonce,
	generateListingId,
	// Deterministic instance DNA for bulk_distribute
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
} from "./dna";

// ============ PAYLOAD CREATION ============
export {
	// Payload creators
	createBulkDistributePayload,
	createBulkDistributeOperation,
	createTransferPayload,
	createBulkTransferPayload,
	createBulkBurnPayload,
	createSetDataPayload,
	createDataOperatorApprovePayload,
	createDataOperatorApproveOperation,
	createSetDataFromPayload,
	createSetDataFromOperation,
	createExtendSchemaPayload,
	createExtendSchemaOperation,
	createArchiveCollectionPayload,
	createArchiveCollectionOperation,
	createListPayload,
	createUnlistPayload,
	createBuyPayload,
	createBuyOperation,
	// Operation creators
	createTransferOperation,
	createBurnOperation,
	createBulkBurnOperation,
	createSetDataOperation,
	createListOperation,
	createUnlistOperation,
	// Deterministic payload & operation creation (anti-duplication)
	createDeterministicCollectionPayload,
	createDeterministicCollectionOperation,
	createDeterministicMintPayload,
	createDeterministicMintOperation,
	toHiveOperation,
	type DeterministicCollectionInput,
	type DeterministicMintInput,
	// Approve & TransferFrom payloads & operations
	createNftApprovePayload,
	createNftApproveOperation,
	createNftApproveAllPayload,
	createNftApproveAllOperation,
	createNftTransferFromPayload,
	createNftTransferFromOperation,
	// Lending payloads & operations
	createNftLendPayload,
	createNftLendOperation,
	createNftReturnPayload,
	createNftReturnOperation,
	createNodeRegisterPayload,
	createNodeRegisterOperation,
	PayloadTooLargeError,
	makePayload,
} from "./payloads";

// ============ PROTOCOL STATE ============
export {
	initProtocol,
	getProtocolVersion,
	getProtocolId,
	isInitialized,
} from "./protocol-state";

// ============ SCHEMAS ============
export * from "./schemas";
export { validateNftOperation } from "./validate";
export type { NftState, PreValidationResult } from "./validate";

// ============ SCHEMA VALIDATION ============
export {
	VALID_SCHEMA_TYPES,
	canonicalJson,
	computeDataHash,
	validateValueAgainstType,
	validateSchemaDefinition,
	validateMintData,
	validateMutableUpdate,
	validateMutableSnapshot,
	mergeSchemas,
} from "./schema-validation";

// ============ SCHEMA TEMPLATES ============
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

// ============ BUILDERS ============
export * from "./builders";

// ============ MULTISIG CLIENT ============
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


// ============ SPV VERIFICATION ============
export {
	// Types
	type HiveL1Config,
	type HafahTransaction,
	type HafahOperationRecord,
	type L1ParsedOperation,
	type VerificationStatus,
	type OnChainVerificationResult,
	type OwnershipVerifyParams,
	type OwnershipVerificationResult,
	type OwnershipCheckResult,
	type DeterministicDerivationParams,
	type DeterministicDerivationResult,
	type OnChainVerifyParams,
	type ListingPriceVerifyParams,
	type ListingPriceVerificationResult,
	type OnChainPrice,
	type ResolveOperationByIdParams,
	type ResolvedOperationById,
	type ResolveMutableDataParams,
	type ResolvedMutableData,
	// Constants
	DEFAULT_HIVE_ENDPOINTS,
	DEFAULT_HIVE_TIMEOUT_MS,
	// L1 Client
	HiveRpcError,
	createDefaultL1Config,
	fetchTransaction,
	fetchOperationById,
	fetchOperationId,
	fetchOperationIds,
	fetchFromHiveRpc,
	parseAllNftloxOperations,
	parseNftloxOperation,
	resolveOperationById,
	resolveMutableDataFromOperation,
	// Verifiers
	verifyDeterministicDerivation,
	verifyOperationOnChain,
	verifyNftOwnership,
	verifyListingPrice,
} from "./spv";

// ============ INHERITANCE (Zero-Duplication) ============
export { resolveInstance } from "./inheritance";

// ============ INDEXER CLIENT ============
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

// ============ UTILS ============
export * from "./utils/tx-sizing";
