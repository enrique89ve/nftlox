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
	test("validates expiration against the supplied chain reference time", () => {
		const referenceTimeMs = Date.now() + 10 * DAY_MS;
		const expiration = toHiveExpiration(referenceTimeMs + 60_000);

		const validated = validateCommonTransactionStructure(
			makeTransaction(expiration),
			{ referenceTimeMs },
		);

		expect(validated.expiration).toBe(expiration);
	});

	test("rejects expiration outside the multisig window from the supplied reference", () => {
		const referenceTimeMs = Date.parse("2026-04-23T00:00:00.000Z");
		const tooSoon = toHiveExpiration(referenceTimeMs + MULTISIG_TX_MIN_EXPIRATION_MS - 1_000);
		const tooFar = toHiveExpiration(referenceTimeMs + MULTISIG_TX_MAX_EXPIRATION_MS + 1_000);

		expect(() => validateCommonTransactionStructure(
			makeTransaction(tooSoon),
			{ referenceTimeMs },
		)).toThrow("expires too soon");
		expect(() => validateCommonTransactionStructure(
			makeTransaction(tooFar),
			{ referenceTimeMs },
		)).toThrow("too far in the future");
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
