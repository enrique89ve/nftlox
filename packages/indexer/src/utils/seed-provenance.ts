import {
	assertProvenanceTarget,
	matchProvenance,
	readDeclaredProvenance,
} from "@nftlox/protocol";
import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { NftProcessingRow } from "@/db/queries/nft-types.ts";

// Narrowed shape of the NFT row needed by `validateSeedProvenance`. Handlers
// typically already fetch the full `NftProcessingRow` via
// `getNftForProcessing[ForUpdate]` — this alias keeps the helper decoupled
// from fields it does not consume.
type NftForProvenance = Pick<NftProcessingRow, "nft_type" | "seed_id">;

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
	nft: NftForProvenance,
	txn: Queryable,
): Promise<void> {
	const declared = readDeclaredProvenance(op.data);
	if (declared === undefined) return;

	assertProvenanceTarget(declared, nft.nft_type);

	let seedCreatedTxId: string | null = null;
	if (declared.seedTxId !== undefined) {
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
		seedCreatedTxId = row.created_tx_id;
	}

	matchProvenance(declared, { seedId: nft.seed_id, seedCreatedTxId });
}
