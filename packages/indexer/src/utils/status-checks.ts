// Unified NFT status validation helpers
// Inspired by ICRC-7 (consistent validation) and AtomicAssets (re-validate at execution time)

import type { NftStatus, NftKind } from "@/db/queries/nfts.ts";
import { NFT_STATUS_LENT, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";

/** Minimal shape needed for status assertions — any row with status qualifies. */
type HasStatus = { readonly status: NftStatus };

/** Extended shape for transferability checks — needs listing expiration info. */
type HasListingExpiry = HasStatus & { readonly listing_expires_at: string | null };

/** Shape for seed guards — needs kind (and optionally distributed count). */
type HasKind = { readonly nft_type: NftKind };
type HasKindAndDistributed = HasKind & { readonly distributed: number };

export function isListingExpired(expiresAt: string | null, blockTimestamp: string): boolean {
	if (!expiresAt) return false;
	return new Date(blockTimestamp).getTime() > new Date(expiresAt).getTime();
}

export function assertNotLent(nft: HasStatus, nftId: string): void {
	if (nft.status === NFT_STATUS_LENT) {
		throw new Error(`NFT is lent and cannot be modified: ${nftId}`);
	}
}

export function assertNotListed(nft: HasStatus, nftId: string): void {
	if (nft.status === NFT_STATUS_LISTED) {
		throw new Error(`NFT is listed and must be unlisted first: ${nftId}`);
	}
}

/**
 * Asserts seeds cannot be delegated (approved/lent to a spender).
 * Seeds are master NFTs — delegation has no valid use case since
 * bulk_distribute doesn't use the allowance system.
 */
export function assertNotSeed(nft: HasKind, nftId: string): void {
	if (nft.nft_type === "seed") {
		throw new Error(`Seeds cannot be delegated: ${nftId}`);
	}
}

/**
 * Asserts a seed with distributed instances cannot change ownership.
 * Following AtomicAssets pattern: templates (seeds) with issued assets are locked.
 * Seeds with distributed === 0 are treated as normal NFTs.
 */
export function assertSeedNotDistributed(nft: HasKindAndDistributed, nftId: string): void {
	if (nft.nft_type === "seed" && nft.distributed > 0) {
		throw new Error(
			`Seed ${nftId} has ${nft.distributed} distributed instance(s) — ownership transfer blocked`,
		);
	}
}

/**
 * Asserts a seed with reserved supply cannot change ownership.
 * Even if distributed === 0, some external module has already committed this seed's supply.
 */
export function assertSeedNotReserved(nft: { readonly nft_type: NftKind; readonly reserved_supply?: number }, nftId: string): void {
	if (nft.nft_type === "seed" && (nft.reserved_supply ?? 0) > 0) {
		throw new Error(`Seed ${nftId} has reserved supply — cannot transfer`);
	}
}

/**
 * Base validation: rejects lent NFTs.
 * Every handler that operates on an NFT should call this first.
 * Burned NFTs are hard-deleted so they won't reach this point (NFT not found).
 */
export function assertActionable(nft: HasStatus, nftId: string): void {
	assertNotLent(nft, nftId);
}

/**
 * Asserts the NFT can be transferred/replicated.
 * Rejects: burned, lent, listed (unless listing has expired).
 * Returns true if the listing was expired (caller should clean up listing fields).
 */
export function assertTransferable(nft: HasListingExpiry, nftId: string, blockTimestamp: string): { hadExpiredListing: boolean } {
	assertActionable(nft, nftId);

	if (nft.status === NFT_STATUS_LISTED) {
		if (!isListingExpired(nft.listing_expires_at, blockTimestamp)) {
			throw new Error(`NFT is listed for sale and must be unlisted first: ${nftId}`);
		}
		return { hadExpiredListing: true };
	}

	return { hadExpiredListing: false };

}

/**
 * Full ownership-change guard: actionable + not a distributed seed.
 * Use for transfer, buy — any operation that changes the NFT owner.
 */
export function assertOwnershipChangeable(
	nft: HasListingExpiry & HasKindAndDistributed,
	nftId: string,
	blockTimestamp: string,
): { hadExpiredListing: boolean } {
	const result = assertTransferable(nft, nftId, blockTimestamp);
	assertSeedNotDistributed(nft, nftId);
	assertSeedNotReserved(nft, nftId);
	return result;
}
