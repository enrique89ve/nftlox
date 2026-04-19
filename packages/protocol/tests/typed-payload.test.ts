import { describe, expect, test } from "bun:test";
import { narrowPayload } from "../src/types";
import { ACTION_BUY, ACTION_MINT } from "../src/constants";

describe("narrowPayload", () => {
	test("returns the payload when action matches", () => {
		const p = {
			protocol: "nftlox_testnet",
			version: "0.6.0",
			action: ACTION_BUY,
			data: {
				nftId: "inst_x",
				listingId: "list_y",
				listTxId: "t",
				txId: "u",
			},
		} as const;
		const narrowed = narrowPayload(p, ACTION_BUY);
		expect(narrowed).not.toBeNull();
		expect(narrowed?.data.nftId).toBe("inst_x");
	});

	test("returns null when action does not match", () => {
		const p = {
			protocol: "nftlox_testnet",
			version: "0.6.0",
			action: ACTION_MINT,
			data: {},
		} as const;
		expect(narrowPayload(p, ACTION_BUY)).toBeNull();
	});
});
