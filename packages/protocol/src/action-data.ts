// NFTLox Protocol — action-specific data payload types.
// These define the `data` shape for each ProtocolAction's ProtocolPayload.

import type {
	CollectionSchema,
	HiveTransactionObject,
	Price,
	SchemaField,
	SeedProvenance,
} from "./types";
import type { NftKind } from "./constants";

// Collection

export type CollectionMetadata = {
	readonly description: string;
	readonly image: string;
	readonly externalUrl?: string | undefined;
};

export type CollectionRules = {
	readonly transferable: boolean;
	readonly burnable: boolean;
	/** Royalty percentage as whole percent (e.g., 5 = 5%). */
	readonly royaltyPct: number;
	readonly royaltyRecipient?: string | undefined;
};

// The on-chain collection payload. `creator` is intentionally absent:
// the indexer derives it from the fee `transfer.from` (canonical source),
// and the `id` is a deterministic hash of (creator, name, symbol) — so the
// creator is already bound to the id. Keeping it out of the payload removes
// a redundant field and a whole class of drift/validation concerns.
export type CollectionData = {
	readonly id: string;
	readonly name: string;
	readonly symbol: string;
	readonly totalPotential: number;
	// Hard cap on total instances mintable across the collection's seeds.
	// 0 = unlimited (subject only to the per-creator cap). When > 0, must be
	// a multiple of INSTANCE_FEE_PER_N. Stored immutably; drives the scaled
	// fee math when INSTANCE_FEE_ENABLED.
	readonly maxInstances: number;
	readonly originDna: string;
	readonly metadata: CollectionMetadata;
	readonly rules: CollectionRules;
	readonly schema?: CollectionSchema | undefined;
};

export type ArchiveCollectionData = {
	readonly collectionId: string;
};

export type ExtendSchemaData = {
	readonly collectionId: string;
	readonly newImmutableFields?: readonly SchemaField[] | undefined;
	readonly newMutableFields?: readonly SchemaField[] | undefined;
};

// NFT (mint / seed)

export type NFTMetadata = {
	readonly name: string;
	readonly description?: string | undefined;
	readonly imageUrl: string;
	readonly imageHash: string;
};

export type NFTData = {
	readonly id: string;
	readonly collectionId: string;
	// Creator-chosen per-seed asset identifier. Required for `mint` (indexer
	// recomputes `id = generateDeterministicSeedId(collectionId, artId)` and
	// rejects mismatches). Omitted for instances — those derive their id from
	// (seedId, instanceNumber) and inherit art via FK.
	readonly artId?: string | undefined;
	readonly edition: number;
	readonly owner: string;
	// Intentionally required: every custom_json must declare the NFT kind
	// explicitly so an auditor reading the operation on-chain can recreate
	// ownership via the Hive API without relying on the indexer to infer it.
	readonly nftType: NftKind;
	readonly originDna: string;
	readonly nftDna: string;
	readonly uniqueAccessKey?: string | undefined;
	readonly mintedBy: string;
	readonly collectionBlock?: number | undefined;
	readonly metadata: NFTMetadata;
	readonly maxSupply: number;
	readonly immutableData?: Record<string, unknown> | undefined;
	readonly mutableData?: Record<string, unknown> | undefined;
	readonly data?: Record<string, unknown> | undefined;
};

// Bulk distribute

export type BulkDistributeItem = {
	readonly seedId: string;
	readonly quantity: number;
	/** The seed's tx_id — indexer validates against seed's actual tx_id. */
	readonly seedTxId: string;
};

export type BulkDistributeData = {
	readonly to?: string | undefined;
	readonly items: readonly BulkDistributeItem[];
	readonly imageOverrides?: Readonly<Record<string, { readonly imageUrl?: string | undefined; readonly imageHash?: string | undefined }>> | undefined;
	readonly data?: Record<string, unknown> | undefined;
	readonly mutableData?: Record<string, unknown> | undefined;
};

// Transfer (burn = transfer to "null")

export type TransferData = SeedProvenance & {
	readonly nftId?: string | undefined;
	readonly nftIds?: readonly string[] | undefined;
	readonly from: string;
	readonly to: string;
	readonly imageUrl?: string | undefined;
	readonly imageHash?: string | undefined;
};

// Set data

export type SetDataData = {
	readonly nftId: string;
	readonly nftDna: string;
	readonly data?: Record<string, unknown> | undefined;
	readonly mutableData?: Record<string, unknown> | undefined;
	readonly seedId?: string | undefined;
	readonly seedTxId?: string | undefined;
};

// Data operator

export type DataOperatorApproveData = {
	readonly collectionId: string;
	readonly operator: string;
	readonly approved: boolean;
};

export type SetDataFromData = SeedProvenance & {
	readonly nftId: string;
	readonly nftDna: string;
	readonly data?: Record<string, unknown> | undefined;
	readonly mutableData?: Record<string, unknown> | undefined;
};

// Marketplace

export type ListingData = SeedProvenance & {
	readonly nftId: string;
	readonly listingId: string;
	readonly listingNonce: string;
	readonly price: Price;
	readonly expiresAt?: number | undefined;
	readonly imageUrl?: string | undefined;
	readonly imageHash?: string | undefined;
	readonly marketplace?: string | undefined;
};

export type UnlistData = {
	readonly nftId: string;
	readonly imageUrl?: string | undefined;
	readonly imageHash?: string | undefined;
	readonly seedId?: string | undefined;
	readonly seedTxId?: string | undefined;
};

// Emitted on-chain by a settlement node as its active-key custom_json BEFORE
// it co-signs the buyer's buy transaction. The network-wide ordering of these
// commitments in a Hive block is the consensus on "which node gets to settle
// this listing" — first to land wins, others must abort their co-sign flow.
// `txHash` is the digest of the (unsigned) buyer transaction the node will
// co-sign next; `handleBuy` later verifies that the broadcasted transaction's
// hash matches the committed one.
export type BuyCommitmentData = {
	readonly txHash: string;
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly buyer: string;
};

// Embedded in the buyer's active-signed transaction alongside the payment
// transfers. The trailing custom_json is co-signed by the node's active key
// AFTER the node has observed its own `buy_commitment` winning the cross-node
// ordering race. `handleBuy` enforces that the reserving commitment matches.
export type BuyData = {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
};

// Approve & transfer_from

export type NftApproveData = {
	readonly spender: string;
	readonly instanceId: string;
	readonly approved: boolean;
};

export type NftApproveAllData = {
	readonly spender: string;
	readonly collectionId: string;
	readonly approved: boolean;
};

export type NftTransferFromData = SeedProvenance & {
	readonly from: string;
	readonly to: string;
	readonly instanceId: string;
};

// Lending

export type NftLendData = SeedProvenance & {
	readonly instanceId: string;
	readonly borrower: string;
};

export type NftReturnData = SeedProvenance & {
	readonly instanceId: string;
};

// Node register

export type NodeRegisterData = {
	readonly endpoint: string;
};

// Node heartbeat — periodic proof-of-liveness from registered nodes.
// `stateRoot` is the current ownership state-root hash (see
// `packages/indexer/src/utils/state-root-hash.ts`). Consumers compare it with
// their own computed root when exchanging SPV proofs to detect divergence.
export type NodeHeartbeatData = {
	/** Head block the indexer had processed when this heartbeat was produced. */
	readonly blockNum: number;
	/** Ownership state-root hash, formatted as "sha256:<64-hex>". */
	readonly stateRoot: string;
	/** Semver of the indexer binary emitting the heartbeat. */
	readonly indexerVersion: string;
};

// Multisig envelopes

// `creator` is intentionally absent. The multisig endpoint derives the creator
// from the embedded `transaction.operations[0][1].from` (the fee transfer's
// sender), which is the canonical source. Carrying a separate `creator` field
// here would reintroduce the drift vector the payload cleanup removed.
export type CreateCollectionMultisigRequest = {
	readonly transaction: HiveTransactionObject;
};

// `buyer` is intentionally absent. The buy multisig endpoint derives the buyer
// from the embedded transfer sender(s), which is the canonical source for the
// active authority that will later broadcast the fully signed transaction.
export type BuyMultisigRequest = {
	readonly transaction: HiveTransactionObject;
};

export type MultisigRequest = CreateCollectionMultisigRequest | BuyMultisigRequest;

export type PaymentInfo = {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly seller: string;
	/** Decimal Hive asset, 3 decimals. */
	readonly totalPrice: number;
	readonly currency: string;
	readonly sellerAmount: number;
	readonly royaltyAmount: number;
	readonly royaltyRecipient: string | null;
	readonly feeAmount: number;
	readonly feeAccount: string;
	readonly nodeAccount: string;
	readonly txId: string;
	readonly seedTxId: string | null;
};
