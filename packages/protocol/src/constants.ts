// NFTLox Protocol — canonical constants.
// Authoritative source of truth for all protocol-level constants.
// Both the indexer and SDK import from here.
//
// Sections are grouped by conceptual layer:
//   - Identity & versioning            (PROTOCOL_ID, PROTOCOL_VERSION, ...)
//   - On-chain consensus               (rules every node MUST agree on)
//   - Node API policy                  (per-node behavior, NOT consensus)
//   - Payload / transaction limits     (Hive custom_json constraints)
//   - Field & schema limits            (validation bounds)
//   - DNA / ID derivation              (hash lengths, prefixes)
//   - Marketplace                      (currencies, fees, memos)
//   - Batch limits                     (bulk-op caps)
//   - Hash domain separators           (immutable — see note below)
//   - Action names                     (protocol actions)

// ============================================================================
// Identity & versioning
// ============================================================================

export const PROTOCOL_ID = "nftlox_testnet";
export const PROTOCOL_VERSION = "0.6.1";
export const MIN_PROTOCOL_VERSION = "0.6.1";
export const HASH_VERSION = "v1";

// ============================================================================
// On-chain consensus
// Rules every indexer implementation MUST enforce identically. Changing any of
// these is a protocol upgrade and requires coordinated network-wide rollout.
// ============================================================================

// Cooldown blocks an unlist stays pending before materializing to 'active'.
// During the window the NFT keeps status='listed' so a multisig-signed buy
// already in flight can still settle. 3 blocks pairs with
// MULTISIG_LAG_MAX_BLOCKS so every signed buy outlives its originating
// unlist race deterministically across all indexers.
export const UNLIST_DELAY_BLOCKS = 3;

// ============================================================================
// Node API policy
// Per-node behavior. A node operator MAY tune these without breaking consensus
// — they only affect that node's HTTP surface (multisig signing, discovery).
// Clients negotiate via /api/status.
// ============================================================================

export const MULTISIG_EXPIRATION_MS = 125_000;
export const MAX_MULTISIG_OPERATIONS = 5;
export const MULTISIG_TX_MIN_EXPIRATION_MS = 30_000;
export const MULTISIG_TX_MAX_EXPIRATION_MS = 120_000;

// Max block gap between the Hive HEAD and the indexer's last-processed block
// that still allows /api/multisig to sign. Exceeding this means the API would
// read a stale NFT snapshot and could co-sign against state that has since
// been invalidated (unlist/transfer/burn in an un-indexed block). Hive block
// time is 3s, so 3 blocks ≈ 9s.
export const MULTISIG_LAG_MAX_BLOCKS = 3;

// Cadence for on-chain heartbeat (custom_json with current state-root hash).
// Block time on Hive is 3s, so 5000 blocks ≈ 4h10m. Nodes that register must
// publish a heartbeat at least every N blocks or listings are treated as stale
// by consumers of `l2_nodes`. Missing the interval does not remove the node
// from the directory, but buy settlement requires activity within
// MAX_NODE_HEARTBEAT_STALENESS_BLOCKS below.
export const MIN_HEARTBEAT_INTERVAL_BLOCKS = 5000;
// Maximum age for a settlement node to be considered active for buy
// co-signing. Uses block numbers, not wall-clock time, so every indexer makes
// the same accept/reject decision. A node gets one missed-heartbeat grace
// window before its signatures stop settling globally.
export const MAX_NODE_HEARTBEAT_STALENESS_BLOCKS = MIN_HEARTBEAT_INTERVAL_BLOCKS * 2;

// ============================================================================
// Payload / transaction limits
// ============================================================================

export const MAX_JSON_SIZE = 8000;
export const MAX_OPERATIONS_PER_TX = 5;
export const TX_DELAY_MS = 4000;
export const HIVE_CUSTOM_JSON_MAX_BYTES = 8192;
export const SAFE_PAYLOAD_MAX_BYTES = Math.floor(HIVE_CUSTOM_JSON_MAX_BYTES * 0.9);

// ============================================================================
// Field & schema limits
// ============================================================================

export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 250;
export const MAX_IMAGE_URL_LENGTH = 500;
export const MAX_URL_LENGTH = 500;
export const MAX_ID_LENGTH = 128;
// artId is a creator-chosen label bound to one seed within a collection. 64 chars
// fits human-readable slugs ("hero-card-v2") without bloating payload or row size.
export const MAX_ART_ID_LENGTH = 64;
export const MIN_SYMBOL_LENGTH = 3;
export const MAX_SYMBOL_LENGTH = 10;
export const SYMBOL_REGEX = /^[A-Z][A-Z0-9]{2,9}$/;
export const TX_ID_REGEX = /^[0-9a-f]{40}$/;

export const MAX_SCHEMA_FIELDS = 64;
export const MAX_FIELD_NAME_LENGTH = 64;

// ============================================================================
// DNA / ID derivation
// ============================================================================

export const ORIGIN_DNA_LENGTH = 16;
export const INSTANCE_DNA_LENGTH = 20;
export const ACCESS_KEY_LENGTH = 8;
export const INSTANCE_ID_HASH_LENGTH = 20;
export const COLLECTION_ID_HASH_LENGTH = 20;  // was 14 (56 bits) — now 80 bits to match other IDs

// ============================================================================
// Marketplace
// ============================================================================

export const SUPPORTED_CURRENCIES = ["HIVE", "HBD"] as const;
export const MAX_ROYALTY_PCT = 50;
export const MIN_PRICE_AMOUNT = "0.100";
export const BASIS_POINTS_DENOMINATOR = 10_000;
export const PROTOCOL_FEE_BPS = 100;
export const DEFAULT_FEE_ACCOUNT = "nftlox";
export const PROTOCOL_COLLECTION_FEE_HBD = "0.100";
// Listing expirations must outlive the longest buy transaction this node will
// co-sign plus a settlement buffer. Otherwise a seller can list with a short
// expiry, receive buyer funds in a signed Hive transaction, and have the indexer
// reject the NFT ownership change because the listing expired before inclusion.
export const MARKETPLACE_SETTLEMENT_BUFFER_MS = 60_000;
export const MIN_LISTING_TTL_MS = MULTISIG_TX_MAX_EXPIRATION_MS + MARKETPLACE_SETTLEMENT_BUFFER_MS;

// Per-instance fee for create_collection. When enabled, the total fee becomes
//   PROTOCOL_COLLECTION_FEE_HBD + INSTANCE_FEE_UNIT_HBD * ceil(maxInstances / INSTANCE_FEE_PER_N)
// `maxInstances` is declared by the creator in the create_collection payload.
//
// Toggle is `as const false` so TS narrows the conditional in
// payment-requirements.ts to the "fixed" branch at compile time. Flip to
// `true` (and re-typecheck) to activate the scaled adapter that's already
// wired through router → multisig → handler.
export const INSTANCE_FEE_ENABLED = false as const;
export const INSTANCE_FEE_UNIT_HBD = "0.001";
// Granularity / minimum increment of the per-instance fee. Creators must
// declare `maxInstances` in multiples of this number (or 0 for "unlimited"
// modulo the per-creator cap). 1000 keeps fee math at a meaningful chunk
// size — the unit fee is 0.001 HBD, and per-instance billing below 1000 is
// fee-economically irrelevant.
export const INSTANCE_FEE_PER_N = 1000;

// Memo tags — the colon-free token that follows "NFTLox " in a transfer memo.
// Source of truth shared by SDK emitters and the indexer's memo parser.
export const MEMO_TAG_BUY = "BUY";
export const MEMO_TAG_ROYALTY = "ROY";
export const MEMO_TAG_FEE = "FEE";
export const MEMO_TAG_FEE_COL = "FEE-COL";

// Memo prefixes (marketplace + collection-creation transfers). Always built as
// `NFTLox ${MEMO_TAG_*}:` so a typo in one place breaks the build everywhere.
export const MEMO_PREFIX_BUY = `NFTLox ${MEMO_TAG_BUY}:` as const;
export const MEMO_PREFIX_ROYALTY = `NFTLox ${MEMO_TAG_ROYALTY}:` as const;
export const MEMO_PREFIX_FEE = `NFTLox ${MEMO_TAG_FEE}:` as const;
export const MEMO_PREFIX_FEE_COL = `NFTLox ${MEMO_TAG_FEE_COL}:` as const;

// Listings
export const LISTING_ID_PREFIX = "list_";
export const LISTING_NONCE_LENGTH = 12;
export const LISTING_HASH_LENGTH = 32;

// ============================================================================
// Batch limits
// ============================================================================

export const MAX_BULK_DISTRIBUTE_ITEMS = 50;
export const MAX_BULK_DISTRIBUTE_TOTAL_QUANTITY = 250;
export const MAX_TRANSFER_BATCH_SIZE = 50;

// ============================================================================
// Protocol actions
// ============================================================================

// Core
export const ACTION_CREATE_COLLECTION = "create_collection";
export const ACTION_MINT = "mint";
export const ACTION_TRANSFER = "transfer";
export const ACTION_BULK_DISTRIBUTE = "bulk_distribute";
export const ACTION_SET_DATA = "set_data";
export const ACTION_EXTEND_SCHEMA = "extend_schema";
export const ACTION_ARCHIVE_COLLECTION = "archive_collection";
export const ACTION_NODE_REGISTER = "node_register";
export const ACTION_NODE_HEARTBEAT = "node_heartbeat";

// Marketplace
export const ACTION_LIST = "list";
export const ACTION_UNLIST = "unlist";
export const ACTION_BUY = "buy" as const;

// Approve & TransferFrom
export const ACTION_NFT_APPROVE = "nft_approve";
export const ACTION_NFT_APPROVE_ALL = "nft_approve_all";
export const ACTION_NFT_TRANSFER_FROM = "nft_transfer_from";

// Lending
export const ACTION_NFT_LEND = "nft_lend";
export const ACTION_NFT_RETURN = "nft_return";

// Data operators
export const ACTION_DATA_OPERATOR_APPROVE = "data_operator_approve";
export const ACTION_SET_DATA_FROM = "set_data_from";

// Category arrays
export const CORE_ACTIONS = [
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_NODE_REGISTER,
	ACTION_NODE_HEARTBEAT,
] as const;

export const MARKETPLACE_ACTIONS = [
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
] as const;

export const APPROVE_ACTIONS = [
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
	...APPROVE_ACTIONS,
	...LENDING_ACTIONS,
	...DATA_OPERATOR_ACTIONS,
] as const;

// ============================================================================
// Hash domain separators
// Permanent pre-image commitments. Changing any separator post-mainnet would
// cause all derived IDs to diverge from historical on-chain data. Treat as
// immutable.
// ============================================================================

export const HASH_DOMAIN_COL = "nftlox:col:";
export const HASH_DOMAIN_ORIGIN = "nftlox:origin:";
export const HASH_DOMAIN_SEED = "nftlox:seed:";
export const HASH_DOMAIN_INST = "nftlox:inst:";
export const HASH_DOMAIN_DNA = "nftlox:dna:";
export const HASH_DOMAIN_KEY = "nftlox:key:";
export const HASH_DOMAIN_INSTANCE = "nftlox:instance:";
export const HASH_DOMAIN_IMG = "nftlox:img:";
export const HASH_DOMAIN_LISTING = "nftlox:listing:v1:";

// ============================================================================
// Type exports
// ============================================================================

export type CoreAction = (typeof CORE_ACTIONS)[number];
export type MarketplaceAction = (typeof MARKETPLACE_ACTIONS)[number];
export type ApproveAction = (typeof APPROVE_ACTIONS)[number];
export type LendingAction = (typeof LENDING_ACTIONS)[number];
export type DataOperatorAction = (typeof DATA_OPERATOR_ACTIONS)[number];
export type ProtocolAction = (typeof ALL_ACTIONS)[number];
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
export type NftKind = "seed" | "instance";

/** Runtime guard: returns true if value is a known ProtocolAction string. */
export function isProtocolAction(value: unknown): value is ProtocolAction {
	return (
		typeof value === "string" &&
		(ALL_ACTIONS as readonly string[]).includes(value)
	);
}
