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
export const PROTOCOL_VERSION = "0.10.0";
export const MIN_PROTOCOL_VERSION = "0.10.0";
export const HASH_VERSION = "v1";

// ============================================================================
// Hive platform constants
// Block cadence and native-asset precision are properties of the Hive L1
// itself — every protocol constant derived from them (TTLs, listing floors,
// amount rounding) must import from here instead of hard-coding the numbers.
// ============================================================================

/** Hive target block time. All *_BLOCKS windows resolve to wall time via this. */
export const HIVE_BLOCK_TIME_MS = 3000;

/** Decimals in Hive-native asset amounts (HIVE, HBD). "1.234 HIVE" has 3. */
export const HIVE_DECIMALS = 3;

/** Multiplier to convert a decimal Hive amount into integer micro-units. */
export const HIVE_PRECISION = 10 ** HIVE_DECIMALS;

/** Tolerance for float → micro-unit roundtrip comparisons. */
export const HIVE_AMOUNT_EPSILON = 1e-9;

// ============================================================================
// On-chain consensus
// Rules every indexer implementation MUST enforce identically. Changing any of
// these is a protocol upgrade and requires coordinated network-wide rollout.
// ============================================================================

// Listing duration window, expressed in blocks (block-denominated so all
// indexers compute the same accept/reject decision regardless of host clock).
// Anchors the MIN_LISTING_TTL_MS / MAX_LISTING_TTL_MS derivations below.
//
// Floor (7 days) — protects against listings that expire inside a normal
// shopping window: long enough that browsing apps don't show stale listings,
// short enough to discourage tying up inventory at obsolete prices. Distinct
// from BUY_COMMITMENT_TTL_BLOCKS (~10 blocks) which is settlement-internal.
//
// Ceiling (60 days) — caps how long an unsold listing can pollute the
// marketplace. Mirrors the OpenSea / LooksRare practice of forcing every
// listing to carry an end time, scaled down to a window that fits a
// game-card use case where prices move on weekly cadences. Re-listing is the
// supported path for sellers who want to extend exposure.
export const LISTING_MIN_DURATION_BLOCKS = 7 * 24 * 60 * 60 * 1000 / HIVE_BLOCK_TIME_MS;   // 201_600
export const LISTING_MAX_DURATION_BLOCKS = 60 * 24 * 60 * 60 * 1000 / HIVE_BLOCK_TIME_MS;  // 1_728_000

// Hive DPoS finality is typically ~15 blocks. API-side multisig flows wait for
// the indexer to observe irreversible state before appending node signatures,
// so every buy settlement window must budget for that finality gap explicitly.
export const HIVE_FINALITY_SAFETY_BLOCKS = 20;

// ============================================================================
// Node API policy
// Per-node behavior. A node operator MAY tune these without breaking consensus
// — they only affect that node's HTTP surface (buy settlement, discovery).
// Clients negotiate via /api/status.
// ============================================================================

// Protocol-internal commitment TTL in clock terms. Anchors
// BUY_COMMITMENT_TTL_BLOCKS below: a `buy_commitment` is valid long enough for
// irreversible observation (~HIVE_FINALITY_SAFETY_BLOCKS) plus final buy
// inclusion. Settlement-internal — clients do not set this, the indexer
// enforces it on the commitment lifecycle.
export const BUY_TX_TTL_MS = 120_000;

// Per-node accepted range for the signed buy tx's `expiration` field at
// POST /api/multisig/buy. Outside this window the indexer rejects with
// INVALID_TX_STRUCTURE.
//
// MIN budgets for irreversible observation plus a short signing/broadcast
// window. A tx that expires sooner may be valid against the indexer's last
// irreversible cursor but already dead at Hive HEAD by the time the node can
// append its signature.
//
// MAX equals the commitment TTL so the signed buy cannot remain broadcastable
// after the reservation window has ended. Human-signing headroom lives before
// the request reaches the node; after submission, the node owns the settlement
// clock.
export const MULTISIG_TX_MIN_EXPIRATION_MS = HIVE_FINALITY_SAFETY_BLOCKS * HIVE_BLOCK_TIME_MS + 30_000;
export const MULTISIG_TX_MAX_EXPIRATION_MS = BUY_TX_TTL_MS;

// SDK default for unsigned buy tx expiration. Equals MAX by design so
// first-class SDK callers get the full finality-safe orchestration window.
export const RECOMMENDED_BUY_TX_EXPIRATION_MS = MULTISIG_TX_MAX_EXPIRATION_MS;

// Block-denominated TTL for `buy_commitment` reservations. A node that emits
// a commitment has this many blocks to get its `buy` transaction included on
// chain; after that the commitment is swept and the NFT returns to `listed`.
// Derived from BUY_TX_TTL_MS so the two windows stay aligned by construction.
export const BUY_COMMITMENT_TTL_BLOCKS = BUY_TX_TTL_MS / HIVE_BLOCK_TIME_MS;

// Per-node cap on concurrently active `buy_commitment` reservations. A single
// node cannot hold more than this many NFTs in `pending_sale` at any block,
// limiting the grief a rogue node can cause.
export const MAX_ACTIVE_COMMITMENTS_PER_NODE = 10;

// Max block gap between Hive's last-irreversible block and the indexer's
// last-processed block that still allows /api/multisig/buy to serve requests.
// Indexers process only up to last_irreversible_block_num (sync-engine.ts) to
// avoid reorg-induced state divergence, so comparing against HEAD would inject
// the ~15-block finality gap into every health check and make the gate
// structurally unsatisfiable. The threshold therefore gates "indexer fell
// behind chain-reported irreversible" — a real fetch/processing backlog —
// at 3 blocks ≈ 9s of unprocessed-but-final data.
export const BUY_API_LAG_MAX_BLOCKS = 3;

// Max wall-clock staleness for the indexer's view of Hive HEAD. Catches the
// case where Hive RPC endpoints are unreachable: lag math stays healthy
// (hive_irreversible_block and last_block both stop advancing together) but
// our timestamp reference becomes increasingly wrong, and any tx the API
// co-signs would carry a stale `expiration` window. 30s ≈ 10 wall-clock
// blocks — long enough to ride out a single endpoint hiccup, short enough
// that integrators can react before signed txs are rejected by witnesses.
export const BUY_API_HEAD_STALENESS_MAX_MS = 30_000;

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

// State-root checkpoint cadence. Aligned with rollup output-root practice
// (~30min-1h). Shorter than heartbeat cadence so divergence is detectable
// within ~50min of the offending block. Must divide evenly into blocks since
// the handler validates alignment via modulo (`blockNum % N === 0`).
//
// Block time on Hive is 3s, so 1000 blocks ≈ 50min. The on-chain action
// `node_state_checkpoint` (see ACTION_NODE_STATE_CHECKPOINT) carries
// `{ blockNum, stateRoot }` and is published by registered nodes once per
// boundary the node has snapshotted locally.
export const STATE_CHECKPOINT_INTERVAL_BLOCKS = 1000;

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
// Optional `marketplace` field in `list` payloads. The string is hashed into
// `listingId` via `generateListingId`, so it MUST round-trip identically
// across UI platforms — NFC normalization is enforced inside the helper, see
// [[project_protocol_hash_inputs_must_be_normalized]]. 20 chars fits short
// identifiers ("nftlox", "norse-mythos") while keeping the canonical
// listing-id preimage bounded and bytes injected by the marketplace owner
// strictly capped.
export const MAX_MARKETPLACE_LENGTH = 20;
// artId is a creator-chosen label bound to one seed within a collection. 64 chars
// fits human-readable slugs ("hero-card-v2") without bloating payload or row size.
export const MAX_ART_ID_LENGTH = 64;
export const MIN_SYMBOL_LENGTH = 3;
export const MAX_SYMBOL_LENGTH = 10;
// Derived so the length bounds stay a single source of truth. First char is
// [A-Z]; remaining chars are [A-Z0-9] for MIN-1 to MAX-1 occurrences.
export const SYMBOL_REGEX = new RegExp(
	`^[A-Z][A-Z0-9]{${MIN_SYMBOL_LENGTH - 1},${MAX_SYMBOL_LENGTH - 1}}$`,
);
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
export const IMAGE_ID_HASH_LENGTH = 16;

// ID and DNA textual prefixes — normative. Each emitter (SDK builders,
// indexer queries, test fixtures) must derive from these; any raw literal in
// source is a drift vector. Changing a prefix is a hardfork: every existing
// id stops matching.
export const COLLECTION_ID_PREFIX = "col_";
export const SEED_ID_PREFIX = "seed_";
export const INSTANCE_ID_PREFIX = "nft_";
export const IMAGE_ID_PREFIX = "img_";
export const ORIGIN_DNA_PREFIX = "o";
// Every NFT DNA (seed or instance) starts with this letter. Seed vs instance
// are distinguished by the hash-domain salt on the preimage
// (HASH_DOMAIN_SEED_DNA vs HASH_DOMAIN_DNA), not by the textual prefix —
// collisions between the two are cryptographically prevented regardless of
// prefix, so the prefix stays a single shared letter.
export const NFT_DNA_PREFIX = "i";

// Canonical textual form for SHA-256 digests — shared by data hashes
// (schema.ts::computeDataHash) and ownership state roots (indexer).
export const HASH_FORMAT_PREFIX = "sha256:";

// Hive reserves the `null` account for native burns. Transferring an NFT to
// this account is how the protocol records a burn.
export const BURN_RECIPIENT = "null";

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
// Wall-time floor for listing TTLs, derived from LISTING_MIN_DURATION_BLOCKS.
// 60s buffer absorbs the gap between the wall clock the SDK uses for input
// validation and the block timestamp the indexer compares against — without
// it, a listing built right at the floor by a slightly-fast client clock
// could land in a block whose timestamp pushes it under MIN.
export const MIN_LISTING_TTL_BUFFER_MS = 60_000;
export const MIN_LISTING_TTL_MS =
	LISTING_MIN_DURATION_BLOCKS * HIVE_BLOCK_TIME_MS + MIN_LISTING_TTL_BUFFER_MS;
export const MAX_LISTING_TTL_MS =
	LISTING_MAX_DURATION_BLOCKS * HIVE_BLOCK_TIME_MS;

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

// Hard upper bound on the creator-declared `maxInstances` for a single
// collection. Defense-in-depth: even though MAX_JSON_SIZE (8000 bytes)
// already prevents arbitrarily large numeric literals from reaching the
// handler, an explicit cap keeps the scaled-fee math (baseHbd + unitHbd *
// maxInstances / INSTANCE_FEE_PER_N) safely below any float-precision or
// string-formatting cliff and protects the global supply envelope across
// the network. 1_000_000 is a round multiple of INSTANCE_FEE_PER_N (1000),
// so every legal `maxInstances` still lands exactly on a fee unit.
export const MAX_INSTANCES_PER_COLLECTION = 1_000_000;

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
// Periodic state-root snapshot taken at exact STATE_CHECKPOINT_INTERVAL_BLOCKS
// boundaries. Mirrors node_heartbeat in shape (signed by the registered node's
// posting key) but carries no indexer version — only `{ blockNum, stateRoot }`.
// The handler enforces alignment (`blockNum % N === 0`) so two nodes that
// processed the same block range publish checkpoints over comparable points.
export const ACTION_NODE_STATE_CHECKPOINT = "node_state_checkpoint";

// Marketplace
export const ACTION_LIST = "list";
export const ACTION_UNLIST = "unlist";
export const ACTION_BUY_COMMITMENT = "buy_commitment" as const;
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
	ACTION_NODE_STATE_CHECKPOINT,
] as const;

export const MARKETPLACE_ACTIONS = [
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY_COMMITMENT,
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
export const HASH_DOMAIN_DNA = "nftlox:dna:";
export const HASH_DOMAIN_KEY = "nftlox:key:";
export const HASH_DOMAIN_SEED_DNA = "nftlox:seed-dna:";
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
