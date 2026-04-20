import { describe, test, expect } from "bun:test";
import { verifyTransfers, type TransferRecord } from "@/utils/validation.ts";

// Regression: a partial match on a failed verifyTransfers used to leak matched
// indices into the shared TransferPool.consumed set, corrupting subsequent ops
// in the same Hive tx. The fix stages matches locally and only commits to the
// shared set after ALL expected transfers are found.

function makeTransfer(overrides: Partial<TransferRecord> = {}): TransferRecord {
	return {
		from: "buyer",
		to: "seller",
		amount: 10.0,
		currency: "HIVE",
		memo: "",
		...overrides,
	};
}

describe("verifyTransfers — TransferPool atomicity", () => {
	test("on partial match failure, shared consumedIndices stays clean", () => {
		// Pool contains only the seller payment — royalty + fee transfers are missing.
		const transfers: TransferRecord[] = [
			makeTransfer({ to: "seller", amount: 8.9, memo: "NFTLox BUY:nft_1" }),
		];
		const consumed = new Set<number>();

		expect(() =>
			verifyTransfers({
				transfers,
				seller: "seller",
				totalPrice: 10,
				currency: "HIVE",
				royaltyPct: 10,
				royaltyRecipient: "artist",
				feeAccount: "feeacc",
				nftId: "nft_1",
				consumedIndices: consumed,
			}),
		).toThrow();

		// Without the atomic-commit fix, index 0 (the seller match) would leak here
		// even though verification as a whole failed, corrupting the pool for the
		// next op in the same tx.
		expect(consumed.size).toBe(0);
	});

	test("on full match success, consumedIndices receives all staged entries", () => {
		const transfers: TransferRecord[] = [
			makeTransfer({ to: "seller", amount: 8.9, memo: "NFTLox BUY:nft_1" }),
			makeTransfer({ to: "artist", amount: 1.0, memo: "NFTLox ROY:nft_1" }),
			makeTransfer({ to: "feeacc", amount: 0.1, memo: "NFTLox FEE:nft_1" }),
		];
		const consumed = new Set<number>();

		verifyTransfers({
			transfers,
			seller: "seller",
			totalPrice: 10,
			currency: "HIVE",
			royaltyPct: 10,
			royaltyRecipient: "artist",
			feeAccount: "feeacc",
			nftId: "nft_1",
			consumedIndices: consumed,
		});

		expect(consumed.size).toBe(3);
		expect([...consumed].sort()).toEqual([0, 1, 2]);
	});

	test("two ops in same tx do not double-claim the same transfer index", () => {
		// Two buys with identical amounts but different memos. Each buy has its own
		// seller/royalty/fee triple; the pool must give each op its own indices.
		const transfers: TransferRecord[] = [
			makeTransfer({ to: "seller", amount: 8.9, memo: "NFTLox BUY:nft_1" }),
			makeTransfer({ to: "artist", amount: 1.0, memo: "NFTLox ROY:nft_1" }),
			makeTransfer({ to: "feeacc", amount: 0.1, memo: "NFTLox FEE:nft_1" }),
			makeTransfer({ to: "seller", amount: 8.9, memo: "NFTLox BUY:nft_2" }),
			makeTransfer({ to: "artist", amount: 1.0, memo: "NFTLox ROY:nft_2" }),
			makeTransfer({ to: "feeacc", amount: 0.1, memo: "NFTLox FEE:nft_2" }),
		];
		const consumed = new Set<number>();

		const base = {
			transfers,
			seller: "seller",
			totalPrice: 10,
			currency: "HIVE" as const,
			royaltyPct: 10,
			royaltyRecipient: "artist",
			feeAccount: "feeacc",
			consumedIndices: consumed,
		};

		verifyTransfers({ ...base, nftId: "nft_1" });
		verifyTransfers({ ...base, nftId: "nft_2" });

		expect(consumed.size).toBe(6);
	});

	test("after partial-fail, a retry with complete pool still succeeds", () => {
		// First call fails (missing fee). Pool must stay empty so the caller can
		// retry with a corrected pool — validates no dirty state leaks.
		const incomplete: TransferRecord[] = [
			makeTransfer({ to: "seller", amount: 9.9, memo: "NFTLox BUY:nft_1" }),
		];
		const consumed = new Set<number>();

		expect(() =>
			verifyTransfers({
				transfers: incomplete,
				seller: "seller",
				totalPrice: 10,
				currency: "HIVE",
				royaltyPct: 0,
				royaltyRecipient: null,
				feeAccount: "feeacc",
				nftId: "nft_1",
				consumedIndices: consumed,
			}),
		).toThrow();
		expect(consumed.size).toBe(0);

		const complete: TransferRecord[] = [
			makeTransfer({ to: "seller", amount: 9.9, memo: "NFTLox BUY:nft_1" }),
			makeTransfer({ to: "feeacc", amount: 0.1, memo: "NFTLox FEE:nft_1" }),
		];
		verifyTransfers({
			transfers: complete,
			seller: "seller",
			totalPrice: 10,
			currency: "HIVE",
			royaltyPct: 0,
			royaltyRecipient: null,
			feeAccount: "feeacc",
			nftId: "nft_1",
			consumedIndices: consumed,
		});
		expect(consumed.size).toBe(2);
	});
});
