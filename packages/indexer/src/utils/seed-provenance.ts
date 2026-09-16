import {
	assertProvenanceTarget,
	matchProvenance,
	readDeclaredProvenance,
} from "@nftlox/protocol";
import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { AssetProcessingRow } from "@/db/queries/asset-types.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

// Narrowed shape of the Asset row needed by `validateSeedProvenance`. Handlers
// typically already fetch the full `AssetProcessingRow` via
// `getAssetForProcessing[ForUpdate]` — this alias keeps the helper decoupled
// from fields it does not consume.
type AssetForProvenance = Pick<AssetProcessingRow, "asset_type" | "seed_id">;

type SeedCreatedTxRow = { created_tx_id: string };

/**
 * Validates the optional `seedId` / `seedTxId` attestations carried in an
 * action payload against the indexer's authoritative view.
 *
 * The pure parser/asserts/matcher live in `@nftlox/protocol`'s
 * `seed-provenance` module — that package owns the contract. This wrapper
 * only adds the database lookup needed to resolve the parent seed's
 * `created_tx_id` when the payload declares `seedTxId`.
 *
 * States:
 *   1. Both fields absent → no-op (backwards-compatible default).
 *   2. Any declared field inconsistent with the DB → throws, rejecting the
 *      whole op. This is how L1 consumers gain the right to trust the
 *      attestation without an indexer round-trip.
 *   3. All declared fields present and correct → pass; the attestation stays
 *      on-chain as a verifiable reference.
 */
export async function validateSeedProvenance(
	op: ParsedOperation,
	asset: AssetForProvenance,
	txn: Queryable,
): Promise<void> {
	const declared = readDeclaredProvenance(op.data);
	if (declared === undefined) return;

	assertProvenanceTarget(declared, asset.asset_type);

	let seedCreatedTxId: string | null = null;
	if (declared.seedTxId !== undefined) {
		if (asset.seed_id === null) {
			throw protocolReject("Cannot validate seedTxId: Asset has no parent seed");
		}
		const [row] = await txn<SeedCreatedTxRow[]>`
			SELECT created_tx_id FROM assets WHERE id = ${asset.seed_id}
		`;
		if (!row) {
			throw protocolReject(
				`Seed not found while validating seedTxId: ${asset.seed_id}`,
			);
		}
		seedCreatedTxId = row.created_tx_id;
	}

	matchProvenance(declared, { seedId: asset.seed_id, seedCreatedTxId });
}
