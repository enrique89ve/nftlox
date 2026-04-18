// ============ NFT DOMAIN TYPES, INTERFACES & CONSTANTS ============

// Counter context types — passed to mutations so counters stay in sync
// within the same transaction. Application-managed, NOT DB triggers.

export type OwnerChangeCtx = {
	readonly oldOwner: string;
	readonly nftType: NftKind;
	readonly collectionId: string;
	readonly ownerAction: OwnershipAction;
	readonly ownerBlockNum: number;
	/** True when the NFT was in 'listed' status before this operation. */
	readonly wasListed: boolean;
};

export type BurnCtx = {
	readonly owner: string;
	readonly nftType: NftKind;
	readonly collectionId: string;
	/** Block at which the burn landed — advances state_meta.last_block_num. */
	readonly blockNum: number;
	/** Hive block timestamp (ISO-8601). Audit row in burned_nfts.created_at. */
	readonly createdAt: string;
};

export type ListingCtx = {
	readonly collectionId: string;
	/** True when the NFT was already in 'listed' status (re-listing expired or unlisting). */
	readonly wasListed: boolean;
};

// ============ ENUMS & PARSERS ============

export type NftKind = "seed" | "instance";
export type NftStatus = "active" | "listed" | "lent";
export type OwnershipAction = "mint" | "bulk_distribute" | "transfer" | "nft_transfer_from" | "buy";

export const VALID_NFT_KINDS = new Set<NftKind>(["seed", "instance"]);
export const VALID_NFT_STATUSES = new Set<NftStatus>(["active", "listed", "lent"]);
export const VALID_OWNERSHIP_ACTIONS = new Set<OwnershipAction>([
	"mint",
	"bulk_distribute",
	"transfer",
	"nft_transfer_from",
	"buy",
]);

export const parseNftKind = (value: string | undefined): NftKind | undefined =>
	value !== undefined && VALID_NFT_KINDS.has(value as NftKind) ? value as NftKind : undefined;

export const parseNftStatus = (value: string | undefined): NftStatus | undefined =>
	value !== undefined && VALID_NFT_STATUSES.has(value as NftStatus) ? value as NftStatus : undefined;

export const parseOwnershipAction = (value: string | undefined): OwnershipAction | undefined =>
	value !== undefined && VALID_OWNERSHIP_ACTIONS.has(value as OwnershipAction) ? value as OwnershipAction : undefined;

export const NFT_STATUS_ACTIVE: NftStatus = "active";
export const NFT_STATUS_LISTED: NftStatus = "listed";
export const NFT_STATUS_LENT: NftStatus = "lent";

export const NFT_KIND_SEED: NftKind = "seed";
export const NFT_KIND_INSTANCE: NftKind = "instance";

// ============ ROW / PARAM INTERFACES ============

export type InsertNftParams = {
	readonly id: string;
	readonly collectionId: string;
	readonly nftType: NftKind;
	readonly status?: NftStatus;
	readonly edition: number;
	readonly owner: string;
	readonly originDna: string | null;
	readonly instanceDna: string | null;
	readonly name: string;
	readonly imageUrl: string | null;
	readonly maxSupply: number;
	readonly distributed?: number;
	readonly seedId: string | null;
	readonly instanceNumber: number | null;
	/** Creator-chosen asset id bound to the canonical seed. NULL for instances. */
	readonly artId: string | null;
	readonly immutableData: Record<string, unknown> | null;
	readonly dataOperationId: string | null;
	readonly dataHash: string | null;
	readonly schemaVersion?: number | null;
	readonly ownerOperationId: string;
	readonly ownerAction: OwnershipAction;
	readonly ownerBlockNum: number;
	readonly createdOperationId: string;
	readonly createdBlockNum: number;
	readonly createdTxId: string;
	readonly createdAt: string;
};

export type NftProcessingRow = {
	readonly id: string;
	readonly owner: string;
	readonly status: NftStatus;
	readonly nft_type: NftKind;
	readonly name: string;
	readonly seed_id: string | null;
	readonly max_supply: number;
	readonly distributed: number;
	readonly reserved_supply: number;
	readonly collection_id: string;
	readonly instance_dna: string | null;
	readonly listing_id: string | null;
	readonly listing_tx_id: string | null;
	readonly listing_price: string | null;
	readonly listing_currency: string | null;
	readonly listing_expires_at: string | null;
	readonly listing_marketplace: string | null;
	/** Block at which `unlist` was emitted. NULL unless inside the
	 *  UNLIST_DELAY_BLOCKS window; cleared when the sync engine materializes
	 *  the unlist to `status='active'`. */
	readonly pending_unlist_block: number | null;
	readonly data_operation_id: string | null;
};

export type NftWithRulesRow = NftProcessingRow & {
	readonly creator: string;
	readonly transferable: boolean;
	readonly burnable: boolean;
	readonly royalty_pct: string;
	readonly royalty_recipient: string | null;
	readonly created_tx_id: string;
	readonly seed_created_tx_id: string | null;
};

export type SeedWithDnaRow = {
	readonly id: string;
	readonly owner: string;
	readonly status: NftStatus;
	readonly nft_type: NftKind;
	readonly name: string;
	readonly seed_id: string | null;
	readonly max_supply: number;
	readonly distributed: number;
	readonly reserved_supply: number;
	readonly collection_id: string;
	readonly instance_dna: string | null;
	readonly origin_dna: string | null;
	readonly image_url: string | null;
	readonly created_tx_id: string;
	readonly schema_version: number;
};

export type SeedWithSchemaRow = SeedWithDnaRow & {
	readonly schema: unknown | null;
	readonly schema_version: number;
};

export type UserNftCounts = {
	readonly total: number;
	readonly seeds: number;
	readonly instances: number;
};

export type ListSort = "price_asc" | "price_desc" | "recent";

export type NftListQuery =
	| { readonly by: "owner"; readonly owner: string; readonly status?: NftStatus; readonly type?: NftKind }
	| { readonly by: "collection"; readonly collectionId: string; readonly type?: NftKind }
	| { readonly by: "seed"; readonly seedId: string }
	| { readonly by: "listed"; readonly sort?: ListSort; readonly currency?: string };

export type Pagination = { readonly limit?: number; readonly offset?: number };

export type NftListRow = {
	readonly id: string;
	readonly collection_id: string;
	readonly nft_type: NftKind;
	readonly status: NftStatus;
	readonly edition: number;
	readonly owner: string;
	readonly name: string;
	readonly image_url: string | null;
	readonly origin_dna: string | null;
	readonly immutable_data: Record<string, unknown> | null;
	readonly instance_dna: string | null;
	readonly seed_id: string | null;
	readonly instance_number: number | null;
	readonly seed_tx_id: string | null;
	readonly max_supply: number;
	readonly distributed: number;
	readonly supply_exhausted: boolean;
	readonly schema_version: number | null;
	readonly previous_owner: string | null;
	readonly owner_operation_id: string;
	readonly owner_action: OwnershipAction;
	readonly owner_block_num: number;
	readonly listing_id: string | null;
	readonly listing_tx_id: string | null;
	readonly listing_price: string | null;
	readonly listing_currency: string | null;
	readonly listing_expires_at: string | null;
	readonly listing_marketplace: string | null;
	readonly created_at: string;
};

export type NftPageResult = {
	readonly nfts: ReadonlyArray<NftListRow>;
	readonly counts: UserNftCounts;
};

export type NftOwnerClaim = Readonly<{
	readonly id: string;
	readonly owner: string;
	readonly previous_owner: string | null;
	readonly owner_action: OwnershipAction;
	readonly owner_operation_id: string;
	readonly owner_block_num: number;
	readonly claim_hash: string;
}>;

export type NftOwnershipProof = NftOwnerClaim & Readonly<{
	readonly created_operation_id: string;
	readonly created_block_num: number;
	readonly created_tx_id: string;
	readonly nft_type: NftKind;
	readonly seed_id: string | null;
	readonly instance_number: number | null;
	readonly instance_dna: string | null;
}>;
