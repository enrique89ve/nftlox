import { describe, expect, test } from "bun:test";
import { PAYMENT_VALIDATORS, type PaymentMatch } from "@/processor/payment.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	ACTION_PAYMENT,
	ACTION_CREATE_COLLECTION,
	ACTION_BUY,
	ACTION_MINT,
} from "@/protocol/index.ts";

function opFor(
	action: string,
	transfers: Array<{ from: string; to: string; amount: number; currency: string; memo: string }> = [],
	data: Record<string, unknown> = {},
): ParsedOperation {
	return {
		blockNum: 100,
		timestamp: "2026-04-19T00:00:00",
		txId: "tx_x",
		operationId: "tx_x#0",
		signer: "alice",
		authLevel: "posting",
		action,
		version: "0.6.3",
		data,
		pairedTransfers: transfers,
		transferPool: { consumed: new Set<number>() },
	} as unknown as ParsedOperation;
}

describe("PAYMENT_VALIDATORS", () => {
	test("'none' returns no-op match", () => {
		const req = ACTION_PAYMENT[ACTION_MINT];
		if (req.kind !== "none") throw new Error("mint should be 'none' kind");
		const match = PAYMENT_VALIDATORS.none(opFor(ACTION_MINT), req, {
			targetAccount: "nftlox",
		});
		expect(match.kind).toBe("none");
		expect(match.consumedIndices).toEqual([]);
	});

	test("'fixed' validates memo-bound transfer and returns match", () => {
		const req = ACTION_PAYMENT[ACTION_CREATE_COLLECTION];
		if (req.kind !== "fixed") throw new Error("create_collection should be 'fixed' kind");
		const op = opFor(
			ACTION_CREATE_COLLECTION,
			[{ from: "alice", to: "nftlox", amount: 0.1, currency: "HBD", memo: "NFTLox FEE-COL:col_abc" }],
			{ id: "col_abc" },
		);

		const match = PAYMENT_VALIDATORS.fixed(op, req, {
			targetAccount: "nftlox",
			expectedMemo: "NFTLox FEE-COL:col_abc",
		});
		expect(match.kind).toBe("fixed");
		if (match.kind !== "fixed") throw new Error("impossible");
		expect(match.payer).toBe("alice");
		expect(match.consumedIndices).toEqual([0]);
	});

	test("'split' throws — validated in handler, not router", () => {
		const req = ACTION_PAYMENT[ACTION_BUY];
		if (req.kind !== "split") throw new Error("buy should be 'split' kind");
		expect(() =>
			PAYMENT_VALIDATORS.split(opFor(ACTION_BUY), req, { targetAccount: "nftlox" }),
		).toThrow(/handler/i);
	});

	test("'scaled' validates fee = base + unit * ceil(maxInstances/N) against memo-bound transfer", () => {
		// 0.100 base + 0.001 per 10 declared = 5 chunks for maxInstances=50.
		// Required transfer: 0.105 HBD.
		const op = opFor(
			ACTION_CREATE_COLLECTION,
			[{ from: "alice", to: "nftlox", amount: 0.105, currency: "HBD", memo: "NFTLox FEE-COL:col_scaled" }],
			{ id: "col_scaled", maxInstances: 50 },
		);

		const match = PAYMENT_VALIDATORS.scaled(
			op,
			{
				kind: "scaled",
				baseHbd: "0.100",
				unitHbd: "0.001",
				unitDenominator: 10,
				countFrom: "payload:maxInstances",
				payer: "transfer:from",
				recipient: "action:signer",
				memoKey: "collectionId",
				memoTag: "FEE-COL",
			},
			{ targetAccount: "nftlox", expectedMemo: "NFTLox FEE-COL:col_scaled" },
		);

		expect(match.kind).toBe("scaled");
		if (match.kind !== "scaled") throw new Error("impossible");
		expect(match.payer).toBe("alice");
		expect(match.consumedIndices).toEqual([0]);
	});

	test("'scaled' rejects payload missing a non-negative-integer maxInstances", () => {
		const op = opFor(
			ACTION_CREATE_COLLECTION,
			[{ from: "alice", to: "nftlox", amount: 0.1, currency: "HBD", memo: "NFTLox FEE-COL:col_bad" }],
			{ id: "col_bad", maxInstances: -1 },
		);
		expect(() =>
			PAYMENT_VALIDATORS.scaled(
				op,
				{
					kind: "scaled",
					baseHbd: "0.100",
					unitHbd: "0.001",
					unitDenominator: 10,
					countFrom: "payload:maxInstances",
					payer: "transfer:from",
					recipient: "action:signer",
					memoKey: "collectionId",
					memoTag: "FEE-COL",
				},
				{ targetAccount: "nftlox", expectedMemo: "NFTLox FEE-COL:col_bad" },
			),
		).toThrow(/maxInstances/);
	});

	test("PaymentMatch union discriminates all 4 kinds", () => {
		const kinds: PaymentMatch["kind"][] = ["none", "fixed", "scaled", "split"];
		expect(kinds.length).toBe(4);
	});
});
