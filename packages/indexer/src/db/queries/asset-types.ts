// ============ Asset DOMAIN TYPES, INTERFACES & CONSTANTS ============

// Counter context types — passed to mutations so counters stay in sync
// within the same transaction. Application-managed, NOT DB triggers.

export type OwnerChangeCtx = {
	readonly oldOwner: string;
	readonly assetType: AssetKind;
	readonly collectionId: string;
	readonly ownerAction: OwnershipAction;
	readonly ownerBlockNum: number;
	/** True when the Asset was in 'listed' status before this operation. */
	readonly wasListed: boolean;
};

export type BurnCtx = {
	readonly owner: string;
	readonly assetType: AssetKind;
	readonly collectionId: string;
	/** Block at which the burn landed — advances state_meta.last_block_num. */
	readonly blockNum: number;
	/** Hive block timestamp (ISO-8601). Audit row in burned_assets.created_at. */
	readonly createdAt: string;
};

export type ListingCtx = {
	readonly collectionId: string;
	/** True when the Asset was already in 'listed' status (re-listing expired or unlisting). */
	readonly wasListed: boolean;
};

// ============ ENUMS & PARSERS ============

export type AssetKind = "seed" | "instance";
export type AssetStatus = "active" | "listed" | "pending_sale" | "lent";
export type OwnershipAction = "mint" | "bulk_distribute" | "transfer" | "asset_transfer_from" | "buy";

export const VALID_ASSET_KINDS = new Set<AssetKind>(["seed", "instance"]);
export const VALID_ASSET_STATUSES = new Set<AssetStatus>(["active", "listed", "pending_sale", "lent"]);
export const VALID_OWNERSHIP_ACTIONS = new Set<OwnershipAction>([
	"mint",
	"bulk_distribute",
	"transfer",
	"asset_transfer_from",
	"buy",
]);

export const parseAssetKind = (value: string | undefined): AssetKind | undefined =>
	value !== undefined && VALID_ASSET_KINDS.has(value as AssetKind) ? value as AssetKind : undefined;

export const parseAssetStatus = (value: string | undefined): AssetStatus | undefined =>
	value !== undefined && VALID_ASSET_STATUSES.has(value as AssetStatus) ? value as AssetStatus : undefined;

export const parseOwnershipAction = (value: string | undefined): OwnershipAction | undefined =>
	value !== undefined && VALID_OWNERSHIP_ACTIONS.has(value as OwnershipAction) ? value as OwnershipAction : undefined;

export const ASSET_STATUS_ACTIVE: AssetStatus = "active";
export const ASSET_STATUS_LISTED: AssetStatus = "listed";
export const ASSET_STATUS_PENDING_SALE: AssetStatus = "pending_sale";
export const ASSET_STATUS_LENT: AssetStatus = "lent";

export const ASSET_KIND_SEED: AssetKind = "seed";
export const ASSET_KIND_INSTANCE: AssetKind = "instance";

// ============ ROW / PARAM INTERFACES ============

export type InsertAssetParams = {
	readonly id: string;
	readonly collectionId: string;
	readonly assetType: AssetKind;
	readonly status?: AssetStatus;
	readonly edition: number;
	readonly owner: string;
	readonly assetDna: string | null;
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

export type AssetProcessingRow = {
	readonly id: string;
	readonly owner: string;
	readonly status: AssetStatus;
	readonly asset_type: AssetKind;
	readonly name: string;
	readonly seed_id: string | null;
	readonly max_supply: number;
	readonly distributed: number;
	readonly reserved_supply: number;
	readonly collection_id: string;
	readonly asset_dna: string | null;
	readonly listing_id: string | null;
	readonly listing_tx_id: string | null;
	readonly listing_price: string | null;
	readonly listing_currency: string | null;
	readonly listing_expires_at: string | null;
	readonly listing_marketplace: string | null;
	/** Buyer reserved by the settlement node while status='pending_sale'. */
	readonly sale_buyer: string | null;
	/** Settlement node account that emitted the buy_commitment. */
	readonly sale_settlement_node: string | null;
	/** Block height at which the pending_sale reservation expires and
	 *  the lazy sweep returns the Asset to status='listed'. */
	readonly sale_expires_block: number | null;
	/** Hive tx_id of the buy_commitment custom_json that created the
	 *  reservation (audit trail). */
	readonly sale_commitment_op_tx_id: string | null;
	/** Digest (tx_id) of the buyer's buy transaction that the settlement
	 *  node committed to co-sign. handleBuy matches this against the current
	 *  tx_id of the `buy` op to refuse settling any other transaction. */
	readonly sale_commitment_buy_tx_hash: string | null;
	readonly data_operation_id: string | null;
};

export type AssetWithRulesRow = AssetProcessingRow & {
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
	readonly status: AssetStatus;
	readonly asset_type: AssetKind;
	readonly name: string;
	readonly seed_id: string | null;
	readonly max_supply: number;
	readonly distributed: number;
	readonly reserved_supply: number;
	readonly collection_id: string;
	readonly asset_dna: string | null;
	readonly origin_dna: string | null;
	readonly image_url: string | null;
	readonly created_tx_id: string;
	readonly schema_version: number;
};

export type SeedWithSchemaRow = SeedWithDnaRow & {
	readonly schema: unknown | null;
	readonly schema_version: number;
	readonly creator: string;
	readonly max_instances: number;
};

export type UserAssetCounts = {
	readonly total: number;
	readonly seeds: number;
	readonly instances: number;
};

export type ListSort = "price_asc" | "price_desc" | "recent";

export type AssetListQuery =
	| { readonly by: "owner"; readonly owner: string; readonly status?: AssetStatus; readonly type?: AssetKind }
	| { readonly by: "collection"; readonly collectionId: string; readonly type?: AssetKind }
	| { readonly by: "seed"; readonly seedId: string }
	| { readonly by: "listed"; readonly sort?: ListSort; readonly currency?: string };

export type Pagination = { readonly limit?: number; readonly offset?: number };

export type AssetListRow = {
	readonly id: string;
	readonly collection_id: string;
	readonly asset_type: AssetKind;
	readonly status: AssetStatus;
	readonly edition: number;
	readonly owner: string;
	readonly name: string;
	readonly image_url: string | null;
	readonly origin_dna: string | null;
	readonly immutable_data: Record<string, unknown> | null;
	readonly asset_dna: string | null;
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

export type AssetPageResult = {
	readonly assets: ReadonlyArray<AssetListRow>;
	readonly counts: UserAssetCounts;
};

export type AssetOwnerClaim = Readonly<{
	readonly id: string;
	readonly owner: string;
	readonly previous_owner: string | null;
	readonly owner_action: OwnershipAction;
	readonly owner_operation_id: string;
	readonly owner_block_num: number;
	readonly claim_hash: string;
}>;

export type AssetOwnershipProof = AssetOwnerClaim & Readonly<{
	readonly created_operation_id: string;
	readonly created_block_num: number;
	readonly created_tx_id: string;
	readonly asset_type: AssetKind;
	readonly seed_id: string | null;
	readonly instance_number: number | null;
	readonly asset_dna: string | null;
	readonly collection_id: string;
	readonly collection_created_block_num: number;
	readonly collection_created_tx_id: string;
}>;
