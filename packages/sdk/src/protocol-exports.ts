import * as protocol from "@nftlox/protocol";

export const PROTOCOL_ID = protocol.PROTOCOL_ID;
export const PROTOCOL_VERSION = protocol.PROTOCOL_VERSION;
export const MIN_PROTOCOL_VERSION = protocol.MIN_PROTOCOL_VERSION;
export const HASH_VERSION = protocol.HASH_VERSION;
export const MAX_JSON_SIZE = protocol.MAX_JSON_SIZE;
export const MAX_OPERATIONS_PER_TX = protocol.MAX_OPERATIONS_PER_TX;
export const TX_DELAY_MS = protocol.TX_DELAY_MS;
export const MAX_NAME_LENGTH = protocol.MAX_NAME_LENGTH;
export const MAX_DESCRIPTION_LENGTH = protocol.MAX_DESCRIPTION_LENGTH;
export const MAX_IMAGE_URL_LENGTH = protocol.MAX_IMAGE_URL_LENGTH;
export const MAX_URL_LENGTH = protocol.MAX_URL_LENGTH;
export const MAX_ID_LENGTH = protocol.MAX_ID_LENGTH;
export const MIN_SYMBOL_LENGTH = protocol.MIN_SYMBOL_LENGTH;
export const MAX_SYMBOL_LENGTH = protocol.MAX_SYMBOL_LENGTH;
export const SYMBOL_REGEX = protocol.SYMBOL_REGEX;
export const TX_ID_REGEX = protocol.TX_ID_REGEX;
export const ORIGIN_DNA_LENGTH = protocol.ORIGIN_DNA_LENGTH;
export const INSTANCE_DNA_LENGTH = protocol.INSTANCE_DNA_LENGTH;
export const ACCESS_KEY_LENGTH = protocol.ACCESS_KEY_LENGTH;
export const INSTANCE_ID_HASH_LENGTH = protocol.INSTANCE_ID_HASH_LENGTH;
export const HIVE_CUSTOM_JSON_MAX_BYTES = protocol.HIVE_CUSTOM_JSON_MAX_BYTES;
export const SAFE_PAYLOAD_MAX_BYTES = protocol.SAFE_PAYLOAD_MAX_BYTES;
export const MAX_BULK_DISTRIBUTE_ITEMS = protocol.MAX_BULK_DISTRIBUTE_ITEMS;
export const MAX_TRANSFER_BATCH_SIZE = protocol.MAX_TRANSFER_BATCH_SIZE;
export const MAX_SCHEMA_FIELDS = protocol.MAX_SCHEMA_FIELDS;
export const MAX_FIELD_NAME_LENGTH = protocol.MAX_FIELD_NAME_LENGTH;
export const SUPPORTED_CURRENCIES = protocol.SUPPORTED_CURRENCIES;
export const MAX_ROYALTY_PCT = protocol.MAX_ROYALTY_PCT;
export const MIN_PRICE_AMOUNT = protocol.MIN_PRICE_AMOUNT;
export const BASIS_POINTS_DENOMINATOR = protocol.BASIS_POINTS_DENOMINATOR;
export const PROTOCOL_FEE_BPS = protocol.PROTOCOL_FEE_BPS;
export const DEFAULT_FEE_ACCOUNT = protocol.DEFAULT_FEE_ACCOUNT;
export const PROTOCOL_COLLECTION_FEE_HBD = protocol.PROTOCOL_COLLECTION_FEE_HBD;
export const MEMO_PREFIX_BUY = protocol.MEMO_PREFIX_BUY;
export const MEMO_PREFIX_ROYALTY = protocol.MEMO_PREFIX_ROYALTY;
export const MEMO_PREFIX_FEE = protocol.MEMO_PREFIX_FEE;
export const LISTING_ID_PREFIX = protocol.LISTING_ID_PREFIX;
export const LISTING_NONCE_LENGTH = protocol.LISTING_NONCE_LENGTH;
export const LISTING_HASH_LENGTH = protocol.LISTING_HASH_LENGTH;
export const MULTISIG_EXPIRATION_MS = protocol.MULTISIG_EXPIRATION_MS;
export const MAX_MULTISIG_OPERATIONS = protocol.MAX_MULTISIG_OPERATIONS;

export const ACTION_CREATE_COLLECTION = protocol.ACTION_CREATE_COLLECTION;
export const ACTION_MINT = protocol.ACTION_MINT;
export const ACTION_TRANSFER = protocol.ACTION_TRANSFER;
export const ACTION_BULK_DISTRIBUTE = protocol.ACTION_BULK_DISTRIBUTE;
export const ACTION_SET_DATA = protocol.ACTION_SET_DATA;
export const ACTION_EXTEND_SCHEMA = protocol.ACTION_EXTEND_SCHEMA;
export const ACTION_ARCHIVE_COLLECTION = protocol.ACTION_ARCHIVE_COLLECTION;
export const ACTION_NODE_REGISTER = protocol.ACTION_NODE_REGISTER;
export const ACTION_NODE_HEARTBEAT = protocol.ACTION_NODE_HEARTBEAT;
export const ACTION_LIST = protocol.ACTION_LIST;
export const ACTION_UNLIST = protocol.ACTION_UNLIST;
export const ACTION_BUY = protocol.ACTION_BUY;
export const ACTION_NFT_APPROVE = protocol.ACTION_NFT_APPROVE;
export const ACTION_NFT_APPROVE_ALL = protocol.ACTION_NFT_APPROVE_ALL;
export const ACTION_NFT_TRANSFER_FROM = protocol.ACTION_NFT_TRANSFER_FROM;
export const ACTION_NFT_LEND = protocol.ACTION_NFT_LEND;
export const ACTION_NFT_RETURN = protocol.ACTION_NFT_RETURN;
export const ACTION_DATA_OPERATOR_APPROVE = protocol.ACTION_DATA_OPERATOR_APPROVE;
export const ACTION_SET_DATA_FROM = protocol.ACTION_SET_DATA_FROM;
export const ALL_ACTIONS = protocol.ALL_ACTIONS;
export const CORE_ACTIONS = protocol.CORE_ACTIONS;
export const MARKETPLACE_ACTIONS = protocol.MARKETPLACE_ACTIONS;
export const APPROVE_ACTIONS = protocol.APPROVE_ACTIONS;
export const LENDING_ACTIONS = protocol.LENDING_ACTIONS;
export const DATA_OPERATOR_ACTIONS = protocol.DATA_OPERATOR_ACTIONS;
export const ACTIVE_AUTH_ACTIONS = protocol.ACTIVE_AUTH_ACTIONS;
export const POSTING_AUTH_ACTIONS = protocol.POSTING_AUTH_ACTIONS;
export const ACTION_AUTH_LEVEL = protocol.ACTION_AUTH_LEVEL;

export const isProtocolAction = protocol.isProtocolAction;
export const getAuthLevel = protocol.getAuthLevel;
export const getKeyType = protocol.getKeyType;
export const getAuthMismatchReason = protocol.getAuthMismatchReason;

export const calculatePaymentSplit = protocol.calculatePaymentSplit;
export const calculateBasisPointsAmount = protocol.calculateBasisPointsAmount;
export const percentageToBasisPoints = protocol.percentageToBasisPoints;
export const roundHive = protocol.roundHive;

export const createPayload = protocol.createPayload;
export const createHiveOperation = protocol.createHiveOperation;
export const PayloadTooLargeError = protocol.PayloadTooLargeError;

export const canonicalJson = protocol.canonicalJson;
export const computeDataHash = protocol.computeDataHash;
export const VALID_SCHEMA_TYPES = protocol.VALID_SCHEMA_TYPES;
export const validateValueAgainstType = protocol.validateValueAgainstType;
export const validateSchemaDefinition = protocol.validateSchemaDefinition;
export const validateMintData = protocol.validateMintData;
export const validateMutableUpdate = protocol.validateMutableUpdate;
export const validateMutableSnapshot = protocol.validateMutableSnapshot;
export const mergeSchemas = protocol.mergeSchemas;

export const generateHash = protocol.generateHash;
export const generateOriginDna = protocol.generateOriginDna;
export const generateInstanceDna = protocol.generateInstanceDna;
export const generateImageHash = protocol.generateImageHash;
export const generateDeterministicCollectionId = protocol.generateDeterministicCollectionId;
export const generateDeterministicSeedId = protocol.generateDeterministicSeedId;
export const generateDeterministicInstanceId = protocol.generateDeterministicInstanceId;
export const generateDeterministicInstanceDna = protocol.generateDeterministicInstanceDna;
export const generateDeterministicAccessKey = protocol.generateDeterministicAccessKey;
export const generateInstanceId = protocol.generateInstanceId;
export const extractSeedId = protocol.extractSeedId;
export const extractInstanceNumber = protocol.extractInstanceNumber;
export const isSeedId = protocol.isSeedId;
export const isInstanceId = protocol.isInstanceId;
export const generateListingNonce = protocol.generateListingNonce;
export const generateListingId = protocol.generateListingId;

export type {
	ProtocolAction,
	AuthLevel,
	KeyType,
	ActiveAuthAction,
	PostingAuthAction,
	CoreAction,
	MarketplaceAction,
	ApproveAction,
	LendingAction,
	DataOperatorAction,
	SupportedCurrency,
	ProtocolPayload,
	HiveOperation,
	HiveTransferOperation,
	HiveTransactionObject,
	HiveCustomJsonBody,
	HiveTransferBody,
	Price,
	PaymentSplit,
	SeedProvenance,
	SchemaFieldType,
	SchemaField,
	CollectionSchema,
	CreatePayloadOptions,
	CollectionMetadata,
	CollectionRules,
	CollectionData,
	ArchiveCollectionData,
	ExtendSchemaData,
	NFTMetadata,
	NFTData,
	BulkDistributeItem,
	BulkDistributeData,
	TransferData,
	SetDataData,
	SetDataFromData,
	DataOperatorApproveData,
	ListingData,
	UnlistData,
	BuyData,
	NftApproveData,
	NftApproveAllData,
	NftTransferFromData,
	NftLendData,
	NftReturnData,
	NodeRegisterData,
	NodeHeartbeatData,
	BuyMultisigRequest,
	CreateCollectionMultisigRequest,
	MultisigRequest,
	MultisigErrorCode,
	MultisigResponse,
	PaymentInfo,
} from "@nftlox/protocol";
