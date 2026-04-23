import { describe, expect, test } from "bun:test";
import { assumePayload } from "../src/types";
import { ACTION_BUY, ACTION_MINT } from "../src/constants";

describe("assumePayload", () => {
	test("returns the payload when action matches", () => {
		const p = {
			protocol: "nftlox_testnet",
			version: "0.8.0",
			action: ACTION_BUY,
			data: {
				nftId: "inst_x",
				listingId: "list_y",
				listTxId: "t",
			},
		} as const;
		const narrowed = assumePayload(p, ACTION_BUY);
		expect(narrowed).not.toBeNull();
		expect(narrowed?.data.nftId).toBe("inst_x");
	});

	test("returns null when action does not match", () => {
		const p = {
			protocol: "nftlox_testnet",
			version: "0.8.0",
			action: ACTION_MINT,
			data: {},
		} as const;
		expect(assumePayload(p, ACTION_BUY)).toBeNull();
	});
});
