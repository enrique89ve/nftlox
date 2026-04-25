import { describe, expect, test } from "bun:test";
import { castPayloadByAction } from "../src/payload-assertions";
import { ACTION_BUY, ACTION_MINT } from "../src/constants";

describe("castPayloadByAction", () => {
	test("returns the payload when action matches", () => {
		const p = {
			protocol: "nftlox_testnet",
			version: "0.9.1",
			action: ACTION_BUY,
			data: {
				nftId: "inst_x",
				listingId: "list_y",
				listTxId: "t",
			},
		} as const;
		const narrowed = castPayloadByAction(p, ACTION_BUY);
		expect(narrowed).not.toBeNull();
		expect(narrowed?.data.nftId).toBe("inst_x");
	});

	test("returns null when action does not match", () => {
		const p = {
			protocol: "nftlox_testnet",
			version: "0.9.1",
			action: ACTION_MINT,
			data: {},
		} as const;
		expect(castPayloadByAction(p, ACTION_BUY)).toBeNull();
	});
});
