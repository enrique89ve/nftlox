// Pure validators for the optional `seedId` / `seedTxId` provenance attestation
// carried by 8 protocol actions (transfer, list, unlist, set_data, set_data_from,
// nft_transfer_from, nft_lend, nft_return).
//
// The trust model — see protocol README §"SeedProvenance Attestation" — is
// "opt-in, verified-if-present": a payload may omit both fields, but anything
// declared must match the indexer's authoritative view exactly. Clients
// reading Hive L1 directly can therefore trust the attestation on any accepted
// op without an indexer round-trip.
//
// This module owns the canonical contract. The indexer adds the DB lookup for
// `seedTxId`; the SDK Zod schemas mirror the same shape rules for client-side
// validation. Any divergence here is a protocol-level bug.
//
// Style note: validation follows the explicit `check(condition, "message")`
// pattern used by atomicassets-contract's `checkformat.hpp` — one error per
// case, descriptive enough that the message alone identifies the rejected
// state without further context.

import type { SeedProvenance } from "./types";
import type { NftKind } from "./constants";

/**
 * Reads the optional `seedId` / `seedTxId` attestation from a payload data
 * record.
 *
 * Three states:
 *   - both absent (or `undefined` / `null`)  → returns `undefined`
 *   - any present and well-formed            → returns `{ seedId?, seedTxId? }`
 *   - any present and malformed              → throws
 *
 * "Malformed" means: declared as a non-string, or declared as the empty
 * string. An attestation must point to a real id/txid or be omitted entirely
 * — `seedId: ""` is treated as a bug in the caller, not as "no attestation".
 *
 * Unknown extra fields on `data` are intentionally ignored at this layer:
 * higher-level action validators are responsible for rejecting unexpected
 * payload keys.
 */
export function readDeclaredProvenance(
	data: Record<string, unknown>,
): SeedProvenance | undefined {
	const seedId = readProvenanceField(data, "seedId");
	const seedTxId = readProvenanceField(data, "seedTxId");

	if (seedId === undefined && seedTxId === undefined) return undefined;

	const result: { seedId?: string; seedTxId?: string } = {};
	if (seedId !== undefined) result.seedId = seedId;
	if (seedTxId !== undefined) result.seedTxId = seedTxId;
	return result;
}

/**
 * Asserts that a declared provenance attestation is allowed on the target
 * NFT kind. Seeds have no parent seed by construction, so any provenance
 * declared on a seed is rejected.
 */
export function assertProvenanceTarget(
	declared: SeedProvenance,
	nftType: NftKind,
): void {
	if (nftType === "seed") {
		throw new Error(
			"Seed provenance cannot be declared on a seed NFT — seeds have no parent seed",
		);
	}
}

/**
 * Authoritative view of an instance's parent-seed provenance, supplied by the
 * indexer. `seedCreatedTxId` is the `nfts.created_tx_id` of the parent seed,
 * or `null` when the caller did not load it (only required when the declared
 * attestation includes `seedTxId`).
 */
export type ActualProvenance = {
	readonly seedId: string | null;
	readonly seedCreatedTxId: string | null;
};

/**
 * Compares a declared attestation against the authoritative view.
 *
 * Each declared field is matched independently:
 *   - `seedId` declared    → must equal `actual.seedId`
 *   - `seedTxId` declared  → must equal `actual.seedCreatedTxId`
 *
 * Throws with a message that names the declared and actual values so failures
 * are diagnosable directly from the indexer rejection log.
 *
 * Pure function: no DB, no I/O. Callers (the indexer) are responsible for
 * loading `actual.seedCreatedTxId` only when they need to validate `seedTxId`.
 */
export function matchProvenance(
	declared: SeedProvenance,
	actual: ActualProvenance,
): void {
	if (declared.seedId !== undefined && actual.seedId !== declared.seedId) {
		throw new Error(
			`Declared seedId '${declared.seedId}' does not match actual '${actual.seedId ?? "null"}'`,
		);
	}

	if (declared.seedTxId !== undefined) {
		if (actual.seedCreatedTxId === null) {
			throw new Error("Cannot validate seedTxId: NFT has no parent seed");
		}
		if (actual.seedCreatedTxId !== declared.seedTxId) {
			throw new Error(
				`Declared seedTxId '${declared.seedTxId}' does not match actual '${actual.seedCreatedTxId}'`,
			);
		}
	}
}

// `optional`-style helpers in `utils/validation` treat wrong-type values as
// absent — that would silently bypass attestation checks when a client
// declares a malformed field (e.g. `seedId: 123`). For this trust-boundary
// check we want "declared-but-wrong-type" to fail loudly.
function readProvenanceField(
	data: Record<string, unknown>,
	fieldName: "seedId" | "seedTxId",
): string | undefined {
	if (!Object.prototype.hasOwnProperty.call(data, fieldName)) return undefined;

	const value = data[fieldName];
	if (value === undefined || value === null) return undefined;

	if (typeof value !== "string") {
		throw new Error(
			`${fieldName} must be a string when provided, got ${typeof value}`,
		);
	}
	if (value.length === 0) {
		throw new Error(
			`${fieldName} must be a non-empty string when provided`,
		);
	}
	return value;
}
