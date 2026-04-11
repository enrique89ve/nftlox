/**
 * Pre-validates NFT operations against current state before broadcasting.
 * Pure function — no API calls, no side effects.
 *
 * Usage:
 *   const nft = await fetch("/api/nfts/:id").then(r => r.json());
 *   const result = validateNftOperation("transfer", nft, "alice", nft.id);
 *
 * Limitations (checked only by the indexer, not here):
 *   - Listing expiry (requires block timestamp)
 *   - Spender authorization (nft_transfer_from, nft_approve_all)
 *   - Payment split verification (buy)
 *   - Self-transfer / self-approve / self-lend (requires `to`/`spender` param)
 *   - Schema validation (bulk_distribute mutableData)
 *   - Listing ID / nonce determinism (list)
 */

import type { ProtocolAction } from "./constants";
import {
	ACTION_TRANSFER, ACTION_LIST, ACTION_BUY,
	ACTION_BULK_DISTRIBUTE, ACTION_NFT_APPROVE, ACTION_NFT_TRANSFER_FROM,
	ACTION_NFT_LEND, ACTION_UNLIST,
} from "./constants";

export type NftState = Readonly<{
	status: "active" | "listed" | "burned" | "lent";
	owner: string;
	nft_type: "seed" | "instance";
	distributed: number;
	max_supply: number;
	/** From collection rules — optional, fetched separately via GET /api/collections/:id */
	transferable?: boolean;
	/** From collection rules — optional, fetched separately via GET /api/collections/:id */
	burnable?: boolean;
}>;

export type PreValidationResult = Readonly<{
	valid: boolean;
	errors: readonly string[];
}>;

/** Actions where signer must be the NFT owner. */
const OWNER_REQUIRED: ReadonlySet<string> = new Set([
	ACTION_TRANSFER, ACTION_LIST, ACTION_BULK_DISTRIBUTE,
	ACTION_NFT_LEND, ACTION_NFT_APPROVE, ACTION_UNLIST,
]);

/** Actions that change or expose ownership — require collection.transferable. */
const REQUIRES_TRANSFERABLE: ReadonlySet<string> = new Set([
	ACTION_TRANSFER, ACTION_LIST, ACTION_BUY, ACTION_NFT_TRANSFER_FROM,
	ACTION_NFT_LEND,
]);

/** Actions blocked for all seeds regardless of distributed count. */
const SEED_NEVER_ALLOWED: ReadonlySet<string> = new Set([
	ACTION_NFT_APPROVE, ACTION_NFT_LEND,
]);

/** Actions blocked for seeds with distributed > 0. */
const SEED_DISTRIBUTED_BLOCKED: ReadonlySet<string> = new Set([
	ACTION_TRANSFER, ACTION_LIST, ACTION_BUY, ACTION_NFT_TRANSFER_FROM,
]);

/** Actions that require status === "active" exactly. */
const REQUIRES_ACTIVE: ReadonlySet<string> = new Set([
	ACTION_NFT_LEND,
]);

export function validateNftOperation(
	action: ProtocolAction,
	nft: NftState,
	signer: string,
	nftId: string,
): PreValidationResult {
	const errors: string[] = [];

	// --- Status checks ---

	if (nft.status === "burned") {
		errors.push(`NFT is burned: ${nftId}`);
	}

	if (nft.status === "lent") {
		errors.push(`NFT is lent and cannot be modified: ${nftId}`);
	}

	if (REQUIRES_ACTIVE.has(action) && nft.status !== "active") {
		errors.push(`NFT must be active to ${action}, current status: ${nft.status}`);
	}

	if (nft.status === "listed") {
		if (action === ACTION_LIST) {
			errors.push(`NFT is already listed: ${nftId}`);
		}
	}

	// --- Ownership ---

	if (OWNER_REQUIRED.has(action) && nft.owner !== signer) {
		errors.push(`Signer ${signer} is not the owner of ${nftId}`);
	}

	// --- Seed guards ---

	if (nft.nft_type === "seed" && SEED_NEVER_ALLOWED.has(action)) {
		errors.push(`Seeds cannot be delegated: ${nftId}`);
	}

	if (nft.nft_type === "seed" && nft.distributed > 0 && SEED_DISTRIBUTED_BLOCKED.has(action)) {
		errors.push(`Seed ${nftId} has ${nft.distributed} distributed instance(s) — ownership transfer blocked`);
	}

	// --- Supply ---

	if (action === ACTION_BULK_DISTRIBUTE) {
		if (nft.nft_type !== "seed") {
			errors.push(`${nftId} is not a seed`);
		} else if (nft.max_supply > 0 && nft.distributed >= nft.max_supply) {
			errors.push(`Seed ${nftId} supply exhausted: ${nft.distributed}/${nft.max_supply}`);
		}
	}

	// --- Collection rules (optional — caller may not have fetched collection) ---

	if (REQUIRES_TRANSFERABLE.has(action) && nft.transferable === false) {
		errors.push(`Collection is not transferable`);
	}


	// --- Buy-specific ---

	if (action === ACTION_BUY) {
		if (nft.status !== "listed") {
			errors.push(`NFT is not listed: ${nftId}`);
		}
		if (nft.owner === signer) {
			errors.push(`Cannot buy own NFT: ${nftId}`);
		}
	}

	// --- Unlist-specific ---

	if (action === ACTION_UNLIST && nft.status !== "listed") {
		errors.push(`NFT is not listed: ${nftId}`);
	}

	return { valid: errors.length === 0, errors };
}
