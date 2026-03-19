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

// Protocol Actions (Core)
export const ACTION_CREATE_COLLECTION = "create_collection";
export const ACTION_MINT = "mint";
export const ACTION_TRANSFER = "transfer";
export const ACTION_BURN = "burn";
export const ACTION_REPLICATE = "replicate";
export const ACTION_DISTRIBUTE = "distribute";
export const ACTION_SET_DATA = "set_data";

// Protocol Actions (Marketplace)
export const ACTION_LIST = "list";
export const ACTION_UNLIST = "unlist";
export const ACTION_BUY = "buy";
export const ACTION_OFFER = "offer";
export const ACTION_ACCEPT_OFFER = "accept_offer";
export const ACTION_REJECT_OFFER = "reject_offer";

// All Protocol Actions
export const CORE_ACTIONS = [
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_BURN,
	ACTION_REPLICATE,
	ACTION_DISTRIBUTE,
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

export const ALL_ACTIONS = [...CORE_ACTIONS, ...MARKETPLACE_ACTIONS] as const;

// Type exports
export type CoreAction = (typeof CORE_ACTIONS)[number];
export type MarketplaceAction = (typeof MARKETPLACE_ACTIONS)[number];
export type ProtocolAction = (typeof ALL_ACTIONS)[number];
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
