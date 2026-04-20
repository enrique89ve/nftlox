import { describe, expect, test } from "bun:test";
import { validateFixedFee } from "@/utils/fee-validator.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";

function opWith(transfers: Array<{
	from: string;
	to: string;
	amount: number;
	currency: string;
	memo: string;
}>): ParsedOperation {
	return {
		blockNum: 100,
		timestamp: "2026-04-19T00:00:00",
		txId: "tx_x",
		operationId: "tx_x#0",
		signer: "alice",
		authLevel: "posting",
		action: "create_collection",
		version: "0.6.1",
		data: {},
		pairedTransfers: transfers,
		transferPool: { consumed: new Set<number>() },
	} as unknown as ParsedOperation;
}

describe("validateFixedFee", () => {
	const params = {
		requiredHbd: "0.100",
		targetAccount: "nftlox",
		expectedMemo: "NFTLox FEE-COL:col_abc",
	};

	test("accepts memo-matched exact-amount HBD transfer", () => {
		const op = opWith([
			{ from: "alice", to: "nftlox", amount: 0.1, currency: "HBD", memo: "NFTLox FEE-COL:col_abc" },
		]);
		const match = validateFixedFee({ op, ...params });
		expect(match.payer).toBe("alice");
		expect(match.amount).toBeCloseTo(0.1, 5);
		expect(match.currency).toBe("HBD");
		expect(match.index).toBe(0);
	});

	test("rejects wrong memo", () => {
		const op = opWith([
			{ from: "alice", to: "nftlox", amount: 0.1, currency: "HBD", memo: "NFTLox FEE-COL:other" },
		]);
		expect(() => validateFixedFee({ op, ...params })).toThrow(/memo/i);
	});

	test("rejects wrong recipient", () => {
		const op = opWith([
			{ from: "alice", to: "mallory", amount: 0.1, currency: "HBD", memo: "NFTLox FEE-COL:col_abc" },
		]);
		expect(() => validateFixedFee({ op, ...params })).toThrow();
	});

	test("rejects HBD amount below required (strict equality)", () => {
		const op = opWith([
			{ from: "alice", to: "nftlox", amount: 0.099, currency: "HBD", memo: "NFTLox FEE-COL:col_abc" },
		]);
		expect(() => validateFixedFee({ op, ...params })).toThrow(/amount/i);
	});

	test("rejects HBD amount above required (no overpay tolerance)", () => {
		const op = opWith([
			{ from: "alice", to: "nftlox", amount: 0.101, currency: "HBD", memo: "NFTLox FEE-COL:col_abc" },
		]);
		expect(() => validateFixedFee({ op, ...params })).toThrow(/amount/i);
	});

	test("rejects already-consumed index", () => {
		const op = opWith([
			{ from: "alice", to: "nftlox", amount: 0.1, currency: "HBD", memo: "NFTLox FEE-COL:col_abc" },
		]);
		op.transferPool!.consumed.add(0);
		expect(() => validateFixedFee({ op, ...params })).toThrow();
	});

	test("rejects ambiguous multi-match", () => {
		const op = opWith([
			{ from: "alice", to: "nftlox", amount: 0.1, currency: "HBD", memo: "NFTLox FEE-COL:col_abc" },
			{ from: "alice", to: "nftlox", amount: 0.1, currency: "HBD", memo: "NFTLox FEE-COL:col_abc" },
		]);
		expect(() => validateFixedFee({ op, ...params })).toThrow(/ambiguous|multiple/i);
	});

	test("rejects HIVE payment even with memo/recipient match (HBD-only consensus rule)", () => {
		const op = opWith([
			{ from: "alice", to: "nftlox", amount: 1.0, currency: "HIVE", memo: "NFTLox FEE-COL:col_abc" },
		]);
		expect(() => validateFixedFee({ op, ...params })).toThrow(/must be paid in HBD/i);
	});

	test("rejects unknown currency", () => {
		const op = opWith([
			{ from: "alice", to: "nftlox", amount: 0.1, currency: "USDT", memo: "NFTLox FEE-COL:col_abc" },
		]);
		expect(() => validateFixedFee({ op, ...params })).toThrow(/must be paid in HBD/i);
	});
});
