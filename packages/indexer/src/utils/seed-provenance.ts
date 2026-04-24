import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { NftProcessingRow } from "@/db/queries/nft-types.ts";

// Narrowed shape of the NFT row needed by `validateSeedProvenance`. Handlers
// typically already fetch the full `NftProcessingRow` via
// `getNftForProcessing[ForUpdate]` — this alias keeps the helper decoupled from
// fields it does not consume.
type NftForProvenance = Pick<NftProcessingRow, "nft_type" | "seed_id">;

type SeedCreatedTxRow = { created_tx_id: string };

// `optionalString` from utils/validation treats wrong-type values as absent —
// that would silently bypass provenance validation when a client declares a
// malformed attestation (e.g. `seedId: 123`). For this trust-boundary check
// we want "declared-but-wrong-type" to fail loudly.
function readOptionalPayloadString(
	data: Record<string, unknown>,
	fieldName: "seedId" | "seedTxId",
): string | undefined {
	if (!Object.prototype.hasOwnProperty.call(data, fieldName)) return undefined;

	const value = data[fieldName];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${fieldName} must be a string when provided, got ${typeof value}`);
	}
	return value;
}

/**
 * Validates the optional `seedId` / `seedTxId` attestations carried in an
 * action payload against the indexer's authoritative view.
 *
 * States:
 *   1. Both fields absent  → no-op (backwards-compatible; the payload simply
 *      does not carry the attestation).
 *   2. Any field present but inconsistent with the DB → throws, rejecting the
 *      whole op. The indexer thereby filters out falsely-attested payloads at
 *      write time, so L1 consumers can trust any accepted op's provenance
 *      fields without a round-trip.
 *   3. All declared fields present and correct → pass; the attestation stays
 *      on-chain as a verifiable reference.
 */
export async function validateSeedProvenance(
	op: ParsedOperation,
	nft: NftForProvenance,
	txn: Queryable,
): Promise<void> {
	const declaredSeedId = readOptionalPayloadString(op.data, "seedId");
	const declaredSeedTxId = readOptionalPayloadString(op.data, "seedTxId");
	if (declaredSeedId === undefined && declaredSeedTxId === undefined) return;

	if (nft.nft_type === "seed") {
		throw new Error(
			"Seed provenance cannot be declared on a seed NFT — seeds have no parent seed",
		);
	}

	if (declaredSeedId !== undefined && nft.seed_id !== declaredSeedId) {
		throw new Error(
			`Declared seedId '${declaredSeedId}' does not match actual '${nft.seed_id ?? "null"}'`,
		);
	}

	if (declaredSeedTxId !== undefined) {
		if (nft.seed_id === null) {
			throw new Error("Cannot validate seedTxId: NFT has no parent seed");
		}
		const [row] = await txn<SeedCreatedTxRow[]>`
			SELECT created_tx_id FROM nfts WHERE id = ${nft.seed_id}
		`;
		if (!row) {
			throw new Error(
				`Seed not found while validating seedTxId: ${nft.seed_id}`,
			);
		}
		if (row.created_tx_id !== declaredSeedTxId) {
			throw new Error(
				`Declared seedTxId '${declaredSeedTxId}' does not match actual '${row.created_tx_id}'`,
			);
		}
	}
}
