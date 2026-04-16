// NFTLox Protocol — action-specific data payload types.
// These define the `data` shape for each ProtocolAction's ProtocolPayload.

import type { CollectionSchema, SchemaField, Price, SeedProvenance } from "./types.ts";

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

export type CollectionData = {
	readonly id: string;
	readonly name: string;
	readonly symbol: string;
	readonly creator: string;
	readonly totalPotential: number;
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
	readonly edition: number;
	readonly owner: string;
	readonly nftType?: "seed" | "instance" | undefined;
	readonly originDna: string;
	readonly instanceDna: string;
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
	readonly instanceDna: string;
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
	readonly instanceDna: string;
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

export type BuyData = {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly txId: string;
	readonly seedId?: string | undefined;
	readonly seedTxId?: string | undefined;
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
	readonly publicKey: string;
};

// Multisig envelopes

export type BuyMultisigRequest = Readonly<{
	buyer: string;
	nftId: string;
	listingId: string;
	listTxId: string;
	transaction: import("./types.ts").HiveTransactionObject;
}>;

export type CreateCollectionMultisigRequest = Readonly<{
	creator: string;
	transaction: import("./types.ts").HiveTransactionObject;
}>;

export type MultisigRequest = BuyMultisigRequest | CreateCollectionMultisigRequest;

export type PaymentInfo = Readonly<{
	nftId: string;
	listingId: string;
	listTxId: string;
	seller: string;
	/** Decimal Hive asset, 3 decimals. */
	totalPrice: number;
	currency: string;
	sellerAmount: number;
	royaltyAmount: number;
	royaltyRecipient: string | null;
	feeAmount: number;
	feeAccount: string;
	nodeAccount: string;
	txId: string;
	seedTxId: string | null;
}>;
