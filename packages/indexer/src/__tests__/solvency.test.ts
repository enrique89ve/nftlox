import { describe, expect, test } from "bun:test";
import { assertBuyerSolvent, sumBuyerOutgoing, type FetchBalance } from "@/api/services/multisig/solvency.ts";
import type { ValidatedTransferOp } from "@/api/services/multisig/types.ts";
import type { AccountLiquidBalance } from "@/scanner/hive-client.ts";
import { isMultisigError } from "@/api/services/multisig/errors.ts";

const BUYER = "alice";
const SELLER = "bob";
const ROYALTY = "creator";
const NODE = "node.one";

function makeTransfer(
	from: string,
	to: string,
	amount: number,
	currency: "HIVE" | "HBD",
): ValidatedTransferOp {
	return {
		from,
		to,
		amount: `${amount.toFixed(3)} ${currency}`,
		memo: "",
		parsedAmount: { amount, currency },
	};
}

function balanceOf(hive: number, hbd: number): FetchBalance {
	return async () => ({ hive, hbd });
}

const failingFetcher: FetchBalance = async () => {
	throw new Error("RPC unreachable");
};

describe("sumBuyerOutgoing", () => {
	test("sums only transfers originating from the buyer", () => {
		const ops = [
			makeTransfer(BUYER, SELLER, 10, "HIVE"),
			makeTransfer(BUYER, ROYALTY, 1, "HIVE"),
			makeTransfer(BUYER, NODE, 0.05, "HIVE"),
			// Defensive: a stray non-buyer transfer must not affect the sum.
			makeTransfer(SELLER, BUYER, 999, "HIVE"),
		];
		expect(sumBuyerOutgoing(BUYER, ops)).toEqual({ hive: 11.05, hbd: 0 });
	});

	test("groups by currency", () => {
		const ops = [
			makeTransfer(BUYER, SELLER, 5, "HIVE"),
			makeTransfer(BUYER, SELLER, 12.5, "HBD"),
		];
		expect(sumBuyerOutgoing(BUYER, ops)).toEqual({ hive: 5, hbd: 12.5 });
	});

	test("returns zero when the buyer has no outgoing legs", () => {
		const ops = [makeTransfer(SELLER, BUYER, 1, "HIVE")];
		expect(sumBuyerOutgoing(BUYER, ops)).toEqual({ hive: 0, hbd: 0 });
	});
});

describe("assertBuyerSolvent", () => {
	test("passes when liquid balance covers the required amount exactly", async () => {
		const ops = [makeTransfer(BUYER, SELLER, 10, "HIVE")];
		await expect(
			assertBuyerSolvent(BUYER, ops, balanceOf(10, 0)),
		).resolves.toBeUndefined();
	});

	test("rejects with INSUFFICIENT_BALANCE when HIVE is short", async () => {
		const ops = [makeTransfer(BUYER, SELLER, 10, "HIVE")];
		try {
			await assertBuyerSolvent(BUYER, ops, balanceOf(9.999, 0));
			throw new Error("expected throw");
		} catch (err) {
			expect(isMultisigError(err)).toBe(true);
			if (isMultisigError(err)) expect(err.code).toBe("INSUFFICIENT_BALANCE");
		}
	});

	test("rejects with INSUFFICIENT_BALANCE when HBD is short", async () => {
		const ops = [makeTransfer(BUYER, SELLER, 5, "HBD")];
		try {
			await assertBuyerSolvent(BUYER, ops, balanceOf(1000, 4.999));
			throw new Error("expected throw");
		} catch (err) {
			expect(isMultisigError(err)).toBe(true);
			if (isMultisigError(err)) expect(err.code).toBe("INSUFFICIENT_BALANCE");
		}
	});

	test("validates HIVE first when both currencies are short", async () => {
		const ops = [
			makeTransfer(BUYER, SELLER, 10, "HIVE"),
			makeTransfer(BUYER, SELLER, 5, "HBD"),
		];
		try {
			await assertBuyerSolvent(BUYER, ops, balanceOf(0, 0));
			throw new Error("expected throw");
		} catch (err) {
			expect(isMultisigError(err)).toBe(true);
			if (isMultisigError(err)) {
				expect(err.code).toBe("INSUFFICIENT_BALANCE");
				expect(err.message).toContain("HIVE");
			}
		}
	});

	test("skips the RPC entirely when no funds are required", async () => {
		let called = false;
		const fetcher: FetchBalance = async () => {
			called = true;
			return { hive: 0, hbd: 0 };
		};
		await assertBuyerSolvent(BUYER, [], fetcher);
		expect(called).toBe(false);
	});

	test("maps RPC failures to INTERNAL_ERROR (not INSUFFICIENT_BALANCE)", async () => {
		const ops = [makeTransfer(BUYER, SELLER, 10, "HIVE")];
		try {
			await assertBuyerSolvent(BUYER, ops, failingFetcher);
			throw new Error("expected throw");
		} catch (err) {
			expect(isMultisigError(err)).toBe(true);
			if (isMultisigError(err)) {
				expect(err.code).toBe("INTERNAL_ERROR");
				// Cause is preserved so the API logs surface the underlying RPC error.
				expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
			}
		}
	});

	test("ignores non-buyer transfers when computing the requirement", async () => {
		const ops = [
			makeTransfer(BUYER, SELLER, 1, "HIVE"),
			// If this leg counted, the requirement would jump to 100 HIVE and the
			// 50-HIVE balance would fail the check.
			makeTransfer(SELLER, ROYALTY, 99, "HIVE"),
		];
		await expect(
			assertBuyerSolvent(BUYER, ops, balanceOf(50, 0)),
		).resolves.toBeUndefined();
	});
});
