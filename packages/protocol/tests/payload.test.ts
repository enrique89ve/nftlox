import { describe, test, expect } from "bun:test";
import {
	createPayload,
	createHiveOperation,
	PayloadTooLargeError,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	SAFE_PAYLOAD_MAX_BYTES,
} from "../src/index.ts";

describe("createPayload", () => {
	test("wraps data in protocol envelope with defaults", () => {
		const payload = createPayload("transfer", { nftId: "nft_1", to: "bob" });
		expect(payload.protocol).toBe(PROTOCOL_ID);
		expect(payload.version).toBe(PROTOCOL_VERSION);
		expect(payload.action).toBe("transfer");
		expect(payload.data).toEqual({ nftId: "nft_1", to: "bob" });
	});

	test("accepts explicit protocol/version override", () => {
		const payload = createPayload("transfer", { nftId: "nft_1", to: "bob" }, {
			protocol: "nftlox_mainnet",
			version: "1.0.0",
		});
		expect(payload.protocol).toBe("nftlox_mainnet");
		expect(payload.version).toBe("1.0.0");
	});

	test("rejects invalid action", () => {
		expect(() => createPayload("invalid_action" as "transfer", { nftId: "nft_1", to: "bob" }))
			.toThrow("Unsupported protocol action");
	});
});

describe("createHiveOperation", () => {
	test("posting action uses required_posting_auths", () => {
		const payload = createPayload("transfer", { nftId: "nft_1", to: "bob" });
		const op = createHiveOperation(payload, "alice");
		expect(op[0]).toBe("custom_json");
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
		expect(op[1].id).toBe(PROTOCOL_ID);
	});

	test("active action uses required_auths", () => {
		const payload = createPayload("create_collection", {
			id: "col_1",
			name: "n",
			symbol: "N",
			totalPotential: 1,
			maxInstances: 0,
			originDna: "a".repeat(32),
			metadata: { description: "d", image: "img" },
			rules: { transferable: true, burnable: true, royaltyPct: 0 },
		});
		const op = createHiveOperation(payload, "alice");
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("json field is valid JSON matching payload", () => {
		const payload = createPayload("transfer", { nftId: "nft_1", to: "b" });
		const op = createHiveOperation(payload, "alice");
		const parsed = JSON.parse(op[1].json);
		expect(parsed).toEqual(payload);
	});
});

describe("PayloadTooLargeError", () => {
	test("suggests reduced item count", () => {
		const err = new PayloadTooLargeError(10000, SAFE_PAYLOAD_MAX_BYTES, 50);
		expect(err.suggestedMaxItems).toBeLessThan(50);
		expect(err.suggestedMaxItems).toBeGreaterThan(0);
	});
});
