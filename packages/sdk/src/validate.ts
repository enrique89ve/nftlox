/**
 * Pre-validates Asset operations against current state before broadcasting.
 * Pure function — no API calls, no side effects.
 *
 * Usage:
 *   const asset = await fetch("/api/assets/:id").then(r => r.json());
 *   const result = validateAssetOperation("transfer", asset, "alice", asset.id);
 *
 * Limitations (checked only by the indexer, not here):
 *   - Listing expiry (requires block timestamp)
 *   - Spender authorization (asset_transfer_from, asset_approve_all)
 *   - Payment split verification (buy)
 *   - Self-transfer / self-approve / self-lend (requires `to`/`spender` param)
 *   - Schema validation (bulk_distribute mutableData)
 *   - Listing ID / nonce determinism (list)
 */

import type { ProtocolAction } from "@nftlox/protocol";
import {
	ACTION_TRANSFER, ACTION_LIST, ACTION_BUY,
	ACTION_BULK_DISTRIBUTE, ACTION_ASSET_APPROVE, ACTION_ASSET_TRANSFER_FROM,
	ACTION_ASSET_LEND, ACTION_UNLIST,
} from "@nftlox/protocol";

export type AssetState = Readonly<{
	status: "active" | "listed" | "burned" | "lent";
	owner: string;
	asset_type: "seed" | "instance";
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

/** Actions where signer must be the Asset owner. */
const OWNER_REQUIRED: ReadonlySet<string> = new Set([
	ACTION_TRANSFER, ACTION_LIST, ACTION_BULK_DISTRIBUTE,
	ACTION_ASSET_LEND, ACTION_ASSET_APPROVE, ACTION_UNLIST,
]);

/** Actions that change or expose ownership — require collection.transferable. */
const REQUIRES_TRANSFERABLE: ReadonlySet<string> = new Set([
	ACTION_TRANSFER, ACTION_LIST, ACTION_BUY, ACTION_ASSET_TRANSFER_FROM,
	ACTION_ASSET_LEND,
]);

/** Actions blocked for all seeds regardless of distributed count. */
const SEED_NEVER_ALLOWED: ReadonlySet<string> = new Set([
	ACTION_ASSET_APPROVE, ACTION_ASSET_LEND,
]);

/** Actions blocked for seeds with distributed > 0. */
const SEED_DISTRIBUTED_BLOCKED: ReadonlySet<string> = new Set([
	ACTION_TRANSFER, ACTION_LIST, ACTION_BUY, ACTION_ASSET_TRANSFER_FROM,
]);

/** Actions that require status === "active" exactly. */
const REQUIRES_ACTIVE: ReadonlySet<string> = new Set([
	ACTION_ASSET_LEND,
]);

export function validateAssetOperation(
	action: ProtocolAction,
	asset: AssetState,
	signer: string,
	assetId: string,
): PreValidationResult {
	const errors: string[] = [];

	// --- Status checks ---

	if (asset.status === "burned") {
		errors.push(`Asset is burned: ${assetId}`);
	}

	if (asset.status === "lent") {
		errors.push(`Asset is lent and cannot be modified: ${assetId}`);
	}

	if (REQUIRES_ACTIVE.has(action) && asset.status !== "active") {
		errors.push(`Asset must be active to ${action}, current status: ${asset.status}`);
	}

	if (asset.status === "listed") {
		if (action === ACTION_LIST) {
			errors.push(`Asset is already listed: ${assetId}`);
		}
	}

	// --- Ownership ---

	if (OWNER_REQUIRED.has(action) && asset.owner !== signer) {
		errors.push(`Signer ${signer} is not the owner of ${assetId}`);
	}

	// --- Seed guards ---

	if (asset.asset_type === "seed" && SEED_NEVER_ALLOWED.has(action)) {
		errors.push(`Seeds cannot be delegated: ${assetId}`);
	}

	if (asset.asset_type === "seed" && asset.distributed > 0 && SEED_DISTRIBUTED_BLOCKED.has(action)) {
		errors.push(`Seed ${assetId} has ${asset.distributed} distributed instance(s) — ownership transfer blocked`);
	}

	// --- Supply ---

	if (action === ACTION_BULK_DISTRIBUTE) {
		if (asset.asset_type !== "seed") {
			errors.push(`${assetId} is not a seed`);
		} else if (asset.max_supply > 0 && asset.distributed >= asset.max_supply) {
			errors.push(`Seed ${assetId} supply exhausted: ${asset.distributed}/${asset.max_supply}`);
		}
	}

	// --- Collection rules (optional — caller may not have fetched collection) ---

	if (REQUIRES_TRANSFERABLE.has(action) && asset.transferable === false) {
		errors.push(`Collection is not transferable`);
	}


	// --- Buy-specific ---

	if (action === ACTION_BUY) {
		if (asset.status !== "listed") {
			errors.push(`Asset is not listed: ${assetId}`);
		}
		if (asset.owner === signer) {
			errors.push(`Cannot buy own Asset: ${assetId}`);
		}
	}

	// --- Unlist-specific ---

	if (action === ACTION_UNLIST && asset.status !== "listed") {
		errors.push(`Asset is not listed: ${assetId}`);
	}

	return { valid: errors.length === 0, errors };
}
