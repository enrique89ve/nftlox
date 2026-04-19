import { describe, expect, test } from "bun:test";
import {
	ACTION_PAYMENT,
	getPaymentRequirement,
	type PaymentRequirement,
} from "../src/payment-requirements";
import {
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ALL_ACTIONS,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_FEE_BPS,
} from "../src/constants";

describe("ACTION_PAYMENT registry", () => {
	test("declares an entry for every ProtocolAction", () => {
		for (const action of ALL_ACTIONS) {
			expect(ACTION_PAYMENT[action]).toBeDefined();
		}
	});

	test("create_collection is fixed 0.100 HBD with FEE-COL memo tag", () => {
		const r = ACTION_PAYMENT[ACTION_CREATE_COLLECTION];
		expect(r.kind).toBe("fixed");
		if (r.kind !== "fixed") throw new Error("impossible");
		expect(r.amountHbd).toBe(PROTOCOL_COLLECTION_FEE_HBD);
		expect(r.payer).toBe("transfer:from");
		expect(r.memoKey).toBe("collectionId");
		expect(r.memoTag).toBe("FEE-COL");
	});

	test("buy is split with PROTOCOL_FEE_BPS and BUY/ROY/FEE memo tags", () => {
		const r = ACTION_PAYMENT[ACTION_BUY];
		expect(r.kind).toBe("split");
		if (r.kind !== "split") throw new Error("impossible");
		expect(r.protocolFeeBps).toBe(PROTOCOL_FEE_BPS);
		expect(r.memoKey).toBe("nftId");
		expect(r.memoTags).toEqual({ seller: "BUY", royalty: "ROY", fee: "FEE" });
	});

	test("mint is { kind: 'none' }", () => {
		expect(ACTION_PAYMENT[ACTION_MINT]).toEqual({ kind: "none" });
	});

	test("getPaymentRequirement is total over ProtocolAction — boundary validation is the parser's job", () => {
		// Passing a bogus string requires an explicit `as never` cast; this
		// documents that lookup is total for well-typed callers and any
		// non-ProtocolAction input is undefined-behavior at the type boundary.
		expect(getPaymentRequirement("bogus" as never)).toBeUndefined();
	});

	test("PaymentRequirement union covers 4 kinds", () => {
		const r: PaymentRequirement = ACTION_PAYMENT[ACTION_CREATE_COLLECTION];
		const kinds: PaymentRequirement["kind"][] = [
			"none",
			"fixed",
			"scaled",
			"split",
		];
		expect(kinds).toContain(r.kind);
	});
});
