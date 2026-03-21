// NFTLox Protocol Constants - v0.2.1

export const PROTOCOL_ID = "nftlox_testnet";
export const PROTOCOL_VERSION = "0.2.1";
export const MIN_PROTOCOL_VERSION = "0.2.0";
export const HASH_VERSION = "v1";

// Transaction Limits
export const MAX_JSON_SIZE = 8000;
export const MAX_OPERATIONS_PER_TX = 5;
export const TX_DELAY_MS = 4000;

// Field Limits
export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 250;
export const MAX_IMAGE_URL_LENGTH = 200;
export const MIN_SYMBOL_LENGTH = 3;
export const MAX_SYMBOL_LENGTH = 8;
export const SYMBOL_REGEX = /^[A-Z0-9]{3,8}$/;

// Tag Limits
export const MAX_TAGS = 4;
export const MAX_TAG_LENGTH = 8;
export const TAG_REGEX = /^[a-z0-9_-]{1,8}$/;

// DNA Constants
export const ORIGIN_DNA_LENGTH = 16;
export const INSTANCE_DNA_LENGTH = 14;
export const ACCESS_KEY_LENGTH = 8;

// Marketplace Constants
export const SUPPORTED_CURRENCIES = ["HIVE", "HBD"] as const;
export const MAX_ROYALTY_PCT = 50;
export const MIN_PRICE_AMOUNT = "0.001";

// Pack Constants
export const MAX_DROP_TABLE_ENTRIES = 50;
export const MAX_ITEMS_PER_PACK = 10;
export const MAX_PACK_OPEN_BATCH = 10;
export const MIN_DROP_WEIGHT = 1;
export const MAX_DROP_WEIGHT = 10000;

// Protocol Actions (Core)
export const ACTION_CREATE_COLLECTION = "create_collection";
export const ACTION_MINT = "mint";
export const ACTION_TRANSFER = "transfer";
export const ACTION_BURN = "burn";
export const ACTION_REPLICATE = "replicate";
export const ACTION_BULK_DISTRIBUTE = "bulk_distribute";
export const ACTION_SET_DATA = "set_data";

// Bulk Distribute Limits
export const MAX_BULK_DISTRIBUTE_ITEMS = 50;
export const MAX_BULK_DISTRIBUTE_TOTAL = 100;

// Protocol Actions (Marketplace)
export const ACTION_LIST = "list";
export const ACTION_UNLIST = "unlist";
export const ACTION_BUY = "buy";
export const ACTION_OFFER = "offer";
export const ACTION_ACCEPT_OFFER = "accept_offer";
export const ACTION_REJECT_OFFER = "reject_offer";

// Protocol Actions (Packs)
export const ACTION_PACK_CREATE = "pack_create";
export const ACTION_PACK_BUY = "pack_buy";
export const ACTION_PACK_TRANSFER = "pack_transfer";
export const ACTION_PACK_OPEN = "pack_open";

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

// All Protocol Actions
export const CORE_ACTIONS = [
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_BURN,
	ACTION_REPLICATE,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
] as const;

export const MARKETPLACE_ACTIONS = [
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
	ACTION_OFFER,
	ACTION_ACCEPT_OFFER,
	ACTION_REJECT_OFFER,
] as const;

export const PACK_ACTIONS = [
	ACTION_PACK_CREATE,
	ACTION_PACK_BUY,
	ACTION_PACK_TRANSFER,
	ACTION_PACK_OPEN,
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

export const ALL_ACTIONS = [...CORE_ACTIONS, ...MARKETPLACE_ACTIONS, ...PACK_ACTIONS, ...APPROVE_ACTIONS, ...LENDING_ACTIONS, ...DATA_OPERATOR_ACTIONS] as const;

// Type exports
export type CoreAction = (typeof CORE_ACTIONS)[number];
export type MarketplaceAction = (typeof MARKETPLACE_ACTIONS)[number];
export type PackAction = (typeof PACK_ACTIONS)[number];
export type ApproveAction = (typeof APPROVE_ACTIONS)[number];
export type LendingAction = (typeof LENDING_ACTIONS)[number];
export type DataOperatorAction = (typeof DATA_OPERATOR_ACTIONS)[number];
export type ProtocolAction = (typeof ALL_ACTIONS)[number];
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
