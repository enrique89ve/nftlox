import { describe, expect, test } from "bun:test";
import { requireMultisigChainReferenceTimeMs } from "@/api/services/multisig/chain-time.ts";
import { isMultisigError } from "@/api/services/multisig/errors.ts";
import { validateCommonTransactionStructure } from "@/api/services/multisig/transaction.ts";
import {
	MULTISIG_TX_MAX_EXPIRATION_MS,
	MULTISIG_TX_MIN_EXPIRATION_MS,
} from "@/protocol/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function toHiveExpiration(ms: number): string {
	return new Date(ms).toISOString().split(".")[0]!;
}

function makeTransaction(expiration: string): Record<string, unknown> {
	return {
		ref_block_num: 1,
		ref_block_prefix: 1,
		expiration,
		operations: [],
		extensions: [],
		signatures: [],
	};
}

describe("multisig transaction time validation", () => {
	test("validates MIN against the supplied chain reference time", () => {
		// Chain-anchor 1 day in the past — realistic lag scenario. Under the
		// post-1e31783 split semantics, MIN is measured from chain-anchor (not
		// wall-clock), so a tx with `expiration = referenceTimeMs + MIN + buffer`
		// passes even when the anchor trails wall-clock by 1 day.
		const referenceTimeMs = Date.now() - DAY_MS;
		const expiration = toHiveExpiration(referenceTimeMs + MULTISIG_TX_MIN_EXPIRATION_MS + 10_000);

		const validated = validateCommonTransactionStructure(
			makeTransaction(expiration),
			{ referenceTimeMs },
		);

		expect(validated.expiration).toBe(expiration);
	});

	test("uses Hive HEAD time, not irreversible time, for multisig expiration", () => {
		const headTimeMs = Date.parse("2026-04-23T00:00:45.000Z");
		const referenceTimeMs = requireMultisigChainReferenceTimeMs({
			lastBlock: 1_000,
			hiveHeadBlock: 1_015,
			hiveIrreversibleBlock: 1_000,
			hiveHeadTime: "2026-04-23T00:00:45.000Z",
		});
		const tooSoonAtHead = toHiveExpiration(headTimeMs + MULTISIG_TX_MIN_EXPIRATION_MS - 1_000);

		expect(referenceTimeMs).toBe(headTimeMs);
		expect(() => validateCommonTransactionStructure(
			makeTransaction(tooSoonAtHead),
			{ referenceTimeMs },
		)).toThrow("expires too soon");
	});

	test("rejects expiration below MIN from the chain-anchored reference", () => {
		const referenceTimeMs = Date.parse("2026-04-23T00:00:00.000Z");
		const tooSoon = toHiveExpiration(referenceTimeMs + MULTISIG_TX_MIN_EXPIRATION_MS - 1_000);

		expect(() => validateCommonTransactionStructure(
			makeTransaction(tooSoon),
			{ referenceTimeMs },
		)).toThrow("expires too soon");
	});

	test("rejects expiration above MAX from wall-clock at validation", () => {
		const referenceTimeMs = Date.now();
		const tooFar = toHiveExpiration(Date.now() + MULTISIG_TX_MAX_EXPIRATION_MS + 5_000);

		expect(() => validateCommonTransactionStructure(
			makeTransaction(tooFar),
			{ referenceTimeMs },
		)).toThrow("too far in the future");
	});

	// Discriminating test for the post-1e31783 split semantics: chain-anchored
	// reference lags by 1 block (~3s, realistic case). A tx built wall-clock +
	// MAX lands inside MAX measured from Date.now() but outside MAX measured
	// from the lagging chain-anchor. OLD validator would over-reject.
	test("accepts wall-clock-built tx when chain-anchor lag would over-reject (split semantics)", () => {
		const referenceTimeMs = Date.now() - 3 * 1000;
		const acceptable = toHiveExpiration(Date.now() + MULTISIG_TX_MAX_EXPIRATION_MS);

		const validated = validateCommonTransactionStructure(
			makeTransaction(acceptable),
			{ referenceTimeMs },
		);
		expect(validated.expiration).toBe(acceptable);
	});

	test("refuses delegated decisions when chain time is unavailable", () => {
		try {
			requireMultisigChainReferenceTimeMs({
				lastBlock: 100,
				hiveHeadBlock: 101,
				hiveIrreversibleBlock: 100,
				hiveHeadTime: null,
			});
			throw new Error("expected requireMultisigChainReferenceTimeMs to throw");
		} catch (err: unknown) {
			if (!isMultisigError(err)) throw err;
			expect(err.code).toBe("INDEXER_LAGGED");
			expect(err.retryAfterMs).toBe(3_000);
		}
	});
});
