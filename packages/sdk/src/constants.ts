// NFTLox Protocol Constants - v0.4.1

export const PROTOCOL_ID = "nftlox_testnet";
export const PROTOCOL_VERSION = "0.4.1";
export const MIN_PROTOCOL_VERSION = "0.4.1";
export const HASH_VERSION = "v1";
// Transaction Limits
export const MAX_JSON_SIZE = 8000;
export const MAX_OPERATIONS_PER_TX = 5;
export const TX_DELAY_MS = 4000;

// Field Limits
export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 250;
export const MAX_IMAGE_URL_LENGTH = 500;
export const MIN_SYMBOL_LENGTH = 3;
export const MAX_SYMBOL_LENGTH = 8;
export const SYMBOL_REGEX = /^[A-Z0-9]{3,8}$/;
export const TX_ID_REGEX = /^[0-9a-f]{40}$/;

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

// Listing Constants
export const LISTING_ID_PREFIX = "list_";
export const LISTING_NONCE_LENGTH = 12;
export const LISTING_HASH_LENGTH = 32;

// ============ PAYMENT SPLIT ============

export interface PaymentSplit {
	sellerAmount: number;
	royaltyAmount: number;
	royaltyRecipient: string | null;
	feeAmount: number;
	feeAccount: string;
	totalPrice: number;
	currency: string;
}

/** Round to 3 decimal places (Hive precision) */
export function roundHive(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/**
 * Calculate the payment split for an NFT sale.
 *
 * Protocol fee (1.0%) always goes to the co-signing node.
 * Marketplace fees are handled off-chain by the marketplace frontend.
 *
 * If royaltyRecipient === seller → royalty merges into seller amount.
 * If feeAccount === seller → fee merges into seller amount.
 */
export function calculatePaymentSplit(
	totalPrice: number,
	currency: string,
	royaltyPct: number,
	royaltyRecipient: string | null,
	seller: string,
	feeAccount: string,
): PaymentSplit {
	const feeAmount = roundHive(totalPrice * PROTOCOL_FEE_PCT / 100);

	let royaltyAmount = 0;
	let effectiveRoyaltyRecipient: string | null = null;
	if (royaltyRecipient && royaltyPct > 0) {
		if (royaltyRecipient === seller) {
			royaltyAmount = 0;
			effectiveRoyaltyRecipient = null;
		} else {
			royaltyAmount = roundHive(totalPrice * royaltyPct / 100);
			effectiveRoyaltyRecipient = royaltyRecipient;
		}
	}

	let effectiveFee = feeAmount;
	if (feeAccount === seller) {
		effectiveFee = 0;
	}

	const sellerAmount = totalPrice - royaltyAmount - effectiveFee;

	return {
		sellerAmount,
		royaltyAmount,
		royaltyRecipient: effectiveRoyaltyRecipient,
		feeAmount: effectiveFee,
		feeAccount,
		totalPrice,
		currency,
	};
}

// Hive custom_json payload limit (8KB) with 10% safety margin
export const HIVE_CUSTOM_JSON_MAX_BYTES = 8192;
export const SAFE_PAYLOAD_MAX_BYTES = Math.floor(HIVE_CUSTOM_JSON_MAX_BYTES * 0.90);

// Pack Constants
export const MAX_DROP_TABLE_ENTRIES = 50;
export const MAX_ITEMS_PER_PACK = 20;
export const MAX_PACK_OPEN_BATCH = 50;
export const MIN_DROP_WEIGHT = 1;
export const MAX_DROP_WEIGHT = 10000;

// Schema Constants
export const MAX_SCHEMA_FIELDS = 64;
export const MAX_FIELD_NAME_LENGTH = 64;

// Bulk Distribute Limits
export const MAX_BULK_DISTRIBUTE_ITEMS = 50;

// Protocol Actions (Core)
export const ACTION_CREATE_COLLECTION = "create_collection";
export const ACTION_MINT = "mint";
export const ACTION_TRANSFER = "transfer";
export const ACTION_BURN = "burn";
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

// Atomic Transfer (dual-registro) Constants
// Canonical tracking amount for on-chain transfer+memo verification channel.
// Any atomic NFT transfer pairs a 0.001 HIVE transfer (with structured memo)
// alongside the custom_json, both signed with active key for atomicity.
export const ATOMIC_TRACKING_AMOUNT = "0.001 HIVE";

// Multisig Constants
export const MULTISIG_EXPIRATION_MS = 125_000;
export const MAX_MULTISIG_OPERATIONS = 4; // seller + royalty + fee + custom_json

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

// Authority Classification — Single Source of Truth
// Active key: custody transfers, financial ops, delegation of control
// Posting key: creation, own-data updates, safe/protective actions
export const ACTIVE_AUTH_ACTIONS = [
	ACTION_TRANSFER,
	ACTION_BURN,
	ACTION_LIST,
	ACTION_BUY,
	ACTION_PACK_BUY,
	ACTION_PACK_TRANSFER,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_PACK_APPROVE,
	ACTION_DATA_OPERATOR_APPROVE,
] as const;

export const POSTING_AUTH_ACTIONS = [
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_REPLICATE,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_SET_OWNER_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_UNLIST,
	ACTION_PACK_CREATE,
	ACTION_PACK_OPEN,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_PACK_TRANSFER_FROM,
	ACTION_SET_DATA_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
] as const;

export type ActiveAuthAction = (typeof ACTIVE_AUTH_ACTIONS)[number];
export type PostingAuthAction = (typeof POSTING_AUTH_ACTIONS)[number];

// Type exports
export type CoreAction = (typeof CORE_ACTIONS)[number];
export type MarketplaceAction = (typeof MARKETPLACE_ACTIONS)[number];
export type PackAction = (typeof PACK_ACTIONS)[number];
export type ApproveAction = (typeof APPROVE_ACTIONS)[number];
export type LendingAction = (typeof LENDING_ACTIONS)[number];
export type DataOperatorAction = (typeof DATA_OPERATOR_ACTIONS)[number];
export type ProtocolAction = (typeof ALL_ACTIONS)[number];
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
