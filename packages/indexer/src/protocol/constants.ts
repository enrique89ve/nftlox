// NFTLox Protocol Constants (self-contained copy for indexer)
// Source of truth: packages/sdk/src/constants.ts

export const PROTOCOL_ID = "nftlox_testnet";
export const PROTOCOL_VERSION = "0.4.1";
export const MIN_PROTOCOL_VERSION = "0.4.1";

// Field Limits
export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 250;
export const MAX_IMAGE_URL_LENGTH = 500;
export const MAX_URL_LENGTH = 500;
export const MAX_ID_LENGTH = 128;

// DNA Constants
export const ORIGIN_DNA_LENGTH = 16;
export const INSTANCE_DNA_LENGTH = 20;
export const ACCESS_KEY_LENGTH = 8;
export const INSTANCE_ID_HASH_LENGTH = 20;

// Marketplace Constants
export const SUPPORTED_CURRENCIES = ["HIVE", "HBD"] as const;
export const MAX_ROYALTY_PCT = 50;
export const MIN_PRICE_AMOUNT = "0.001";
export const PROTOCOL_FEE_PCT = 1.0;
export const DEFAULT_FEE_ACCOUNT = "nftlox";

// Memo Prefixes (Marketplace)
export const MEMO_PREFIX_BUY = "NFTLox BUY:";
export const MEMO_PREFIX_ROYALTY = "NFTLox ROY:";
export const MEMO_PREFIX_FEE = "NFTLox FEE:";

// Listing Constants
export const LISTING_ID_PREFIX = "list_";
export const LISTING_NONCE_LENGTH = 12;
export const LISTING_HASH_LENGTH = 32;

// Schema Constants
export const MAX_SCHEMA_FIELDS = 64;
export const MAX_FIELD_NAME_LENGTH = 64;

// Bulk Distribute Limits
export const MAX_BULK_DISTRIBUTE_ITEMS = 50;

// Transfer/Burn Batch Limits
export const MAX_TRANSFER_BATCH_SIZE = 50;

// Pack Constants
export const MAX_PACK_OPEN_BATCH = 50;

// Multisig Constants
export const MULTISIG_EXPIRATION_MS = 125_000;
export const MAX_MULTISIG_OPERATIONS = 4;

// Protocol Actions (Core)
export const ACTION_CREATE_COLLECTION = "create_collection";
export const ACTION_MINT = "mint";
export const ACTION_TRANSFER = "transfer";
export const ACTION_REPLICATE = "replicate";
export const ACTION_BULK_DISTRIBUTE = "bulk_distribute";
export const ACTION_SET_DATA = "set_data";
export const ACTION_SET_OWNER_DATA = "set_owner_data";
export const ACTION_EXTEND_SCHEMA = "extend_schema";
export const ACTION_ARCHIVE_COLLECTION = "archive_collection";

// Protocol Actions (Marketplace)
export const ACTION_LIST = "list";
export const ACTION_UNLIST = "unlist";
export const ACTION_BUY = "buy" as const;

// Protocol Actions (Packs)
export const ACTION_PACK_CREATE = "pack_create";
export const ACTION_PACK_BUY = "pack_buy";
export const ACTION_PACK_TRANSFER = "pack_transfer";
export const ACTION_PACK_OPEN = "pack_open";
export const ACTION_PACK_DESTROY = "pack_destroy";

// Protocol Actions (Approve & TransferFrom)
export const ACTION_PACK_APPROVE = "pack_approve";
export const ACTION_PACK_TRANSFER_FROM = "pack_transfer_from";
export const ACTION_NFT_APPROVE = "nft_approve";
export const ACTION_NFT_APPROVE_ALL = "nft_approve_all";
export const ACTION_NFT_TRANSFER_FROM = "nft_transfer_from";

// Protocol Actions (Lending)
export const ACTION_NFT_LEND = "nft_lend";
export const ACTION_NFT_RETURN = "nft_return";

// Protocol Actions (Data Operators)
export const ACTION_DATA_OPERATOR_APPROVE = "data_operator_approve";
export const ACTION_SET_DATA_FROM = "set_data_from";

// Action Arrays
export const CORE_ACTIONS = [
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_REPLICATE,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_SET_OWNER_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
] as const;

export const MARKETPLACE_ACTIONS = [
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
] as const;

export const PACK_ACTIONS = [
	ACTION_PACK_CREATE,
	ACTION_PACK_BUY,
	ACTION_PACK_TRANSFER,
	ACTION_PACK_OPEN,
	ACTION_PACK_DESTROY,
] as const;

export const APPROVE_ACTIONS = [
	ACTION_PACK_APPROVE,
	ACTION_PACK_TRANSFER_FROM,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
] as const;

export const LENDING_ACTIONS = [
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
] as const;

export const DATA_OPERATOR_ACTIONS = [
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
] as const;

export const ALL_ACTIONS = [
	...CORE_ACTIONS,
	...MARKETPLACE_ACTIONS,
	...PACK_ACTIONS,
	...APPROVE_ACTIONS,
	...LENDING_ACTIONS,
	...DATA_OPERATOR_ACTIONS,
] as const;

// Type exports
export type CoreAction = (typeof CORE_ACTIONS)[number];
export type MarketplaceAction = (typeof MARKETPLACE_ACTIONS)[number];
export type PackAction = (typeof PACK_ACTIONS)[number];
export type ApproveAction = (typeof APPROVE_ACTIONS)[number];
export type LendingAction = (typeof LENDING_ACTIONS)[number];
export type DataOperatorAction = (typeof DATA_OPERATOR_ACTIONS)[number];
export type ProtocolAction = (typeof ALL_ACTIONS)[number];
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
