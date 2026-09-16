// Unified Asset status validation helpers
// Inspired by ICRC-7 (consistent validation) and AtomicAssets (re-validate at execution time)

import type { AssetStatus, AssetKind } from "@/db/queries/assets.ts";
import { ASSET_KIND_INSTANCE, ASSET_STATUS_LENT, ASSET_STATUS_LISTED, ASSET_STATUS_PENDING_SALE } from "@/db/queries/assets.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

/** Minimal shape needed for status assertions — any row with status qualifies. */
type HasStatus = { readonly status: AssetStatus };

/** Extended shape for transferability checks — needs listing expiration info. */
type HasListingExpiry = HasStatus & { readonly listing_expires_at: string | null };

/** Shape for seed guards — needs kind (and optionally distributed count). */
type HasKind = { readonly asset_type: AssetKind };
type HasKindAndDistributed = HasKind & { readonly distributed: number };

export function isListingExpired(expiresAt: string | null, blockTimestamp: string): boolean {
	if (!expiresAt) return false;
	return new Date(blockTimestamp).getTime() >= new Date(expiresAt).getTime();
}

export function assertNotLent(asset: HasStatus, assetId: string): void {
	if (asset.status === ASSET_STATUS_LENT) {
		throw protocolReject(`Asset is lent and cannot be modified: ${assetId}`);
	}
}

export function assertNotListed(asset: HasStatus, assetId: string): void {
	if (asset.status === ASSET_STATUS_LISTED) {
		throw protocolReject(`Asset is listed and must be unlisted first: ${assetId}`);
	}
}

/**
 * Rejects Assets currently reserved by a settlement node's buy_commitment.
 * Every ownership-mutating or transfer-authorizing handler must call this
 * before touching the row: a successful commitment means a buyer-signed
 * buy tx is in flight and our txn must not race it. The row returns to
 * `listed` automatically once `sale_expires_block` elapses (sync-engine
 * sweep in `sweepExpiredBuyCommitments`).
 */
export function assertNotPendingSale(asset: HasStatus, assetId: string): void {
	if (asset.status === ASSET_STATUS_PENDING_SALE) {
		throw protocolReject(`Asset ${assetId} is pending_sale — cannot mutate while a buy_commitment is active`);
	}
}

/**
 * Asserts seeds cannot be delegated (approved/lent to a spender).
 * Seeds are master Assets — delegation has no valid use case since
 * bulk_distribute doesn't use the allowance system.
 */
export function assertNotSeed(asset: HasKind, assetId: string): void {
	if (asset.asset_type === "seed") {
		throw protocolReject(`Seeds cannot be delegated: ${assetId}`);
	}
}

export function assertMarketplaceInstance(asset: HasKind, assetId: string): void {
	if (asset.asset_type !== ASSET_KIND_INSTANCE) {
		throw protocolReject(`Only instances can be listed or bought: ${assetId}`);
	}
}

/**
 * Asserts a seed with distributed instances cannot change ownership.
 * Following AtomicAssets pattern: templates (seeds) with issued assets are locked.
 * Seeds with distributed === 0 are treated as normal Assets.
 */
export function assertSeedNotDistributed(asset: HasKindAndDistributed, assetId: string): void {
	if (asset.asset_type === "seed" && asset.distributed > 0) {
		throw protocolReject(
			`Seed ${assetId} has ${asset.distributed} distributed instance(s) — ownership transfer blocked`,
		);
	}
}

/**
 * Asserts a seed with reserved supply cannot change ownership.
 * Even if distributed === 0, some external module has already committed this seed's supply.
 */
export function assertSeedNotReserved(asset: { readonly asset_type: AssetKind; readonly reserved_supply?: number }, assetId: string): void {
	if (asset.asset_type === "seed" && (asset.reserved_supply ?? 0) > 0) {
		throw protocolReject(`Seed ${assetId} has reserved supply — cannot transfer`);
	}
}

/**
 * Base validation: rejects lent Assets.
 * Every handler that operates on an Asset should call this first.
 * Burned Assets are hard-deleted so they won't reach this point (Asset not found).
 */
export function assertActionable(asset: HasStatus, assetId: string): void {
	assertNotLent(asset, assetId);
}

/**
 * Asserts the Asset can be transferred.
 * Rejects: burned, lent, listed (unless listing has expired).
 * Returns true if the listing was expired (caller should clean up listing fields).
 */
export function assertTransferable(asset: HasListingExpiry, assetId: string, blockTimestamp: string): { hadExpiredListing: boolean } {
	assertActionable(asset, assetId);

	if (asset.status === ASSET_STATUS_LISTED) {
		if (!isListingExpired(asset.listing_expires_at, blockTimestamp)) {
			throw protocolReject(`Asset is listed for sale and must be unlisted first: ${assetId}`);
		}
		return { hadExpiredListing: true };
	}

	return { hadExpiredListing: false };

}

/**
 * Full ownership-change guard: actionable + not a distributed seed.
 * Use for transfer, buy — any operation that changes the Asset owner.
 */
export function assertOwnershipChangeable(
	asset: HasListingExpiry & HasKindAndDistributed,
	assetId: string,
	blockTimestamp: string,
): { hadExpiredListing: boolean } {
	const result = assertTransferable(asset, assetId, blockTimestamp);
	assertSeedNotDistributed(asset, assetId);
	assertSeedNotReserved(asset, assetId);
	return result;
}
