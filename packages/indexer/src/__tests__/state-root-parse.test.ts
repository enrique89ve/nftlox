import { describe, it, expect } from "bun:test";
import { parseNftStateRow } from "@/db/queries/state-root.ts";

const validRow = () => ({
	id: "nft-1",
	owner: "alice",
	previous_owner: "bob",
	owner_action: "transfer",
	owner_operation_id: "op-1",
	owner_block_num: 100,
});

describe("parseNftStateRow", () => {
	it("parses a well-formed row", () => {
		const parsed = parseNftStateRow(validRow());
		expect(parsed).toEqual({
			id: "nft-1",
			owner: "alice",
			previous_owner: "bob",
			owner_action: "transfer",
			owner_operation_id: "op-1",
			owner_block_num: 100,
		});
	});

	it("accepts previous_owner === null", () => {
		const parsed = parseNftStateRow({ ...validRow(), previous_owner: null });
		expect(parsed.previous_owner).toBeNull();
	});

	it("accepts bigint-string owner_block_num (postgres.js default for int8)", () => {
		const parsed = parseNftStateRow({ ...validRow(), owner_block_num: "12345" });
		expect(parsed.owner_block_num).toBe(12345);
	});

	it("accepts native bigint owner_block_num", () => {
		const parsed = parseNftStateRow({ ...validRow(), owner_block_num: 42n });
		expect(parsed.owner_block_num).toBe(42);
	});

	it("rejects null id", () => {
		expect(() => parseNftStateRow({ ...validRow(), id: null })).toThrow(/NftStateRow\.id/);
	});

	it("rejects empty id", () => {
		expect(() => parseNftStateRow({ ...validRow(), id: "" })).toThrow(/NftStateRow\.id/);
	});

	it("rejects null owner", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner: null })).toThrow(/NftStateRow\.owner/);
	});

	it("rejects empty owner", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner: "" })).toThrow(/NftStateRow\.owner/);
	});

	it("rejects non-string previous_owner (e.g. number)", () => {
		expect(() => parseNftStateRow({ ...validRow(), previous_owner: 42 })).toThrow(/NftStateRow\.previous_owner/);
	});

	it("rejects empty-string previous_owner (null is the right sentinel)", () => {
		expect(() => parseNftStateRow({ ...validRow(), previous_owner: "" })).toThrow(/NftStateRow\.previous_owner/);
	});

	it("rejects null owner_action", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner_action: null })).toThrow(/NftStateRow\.owner_action/);
	});

	it("rejects null owner_operation_id", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner_operation_id: null })).toThrow(/NftStateRow\.owner_operation_id/);
	});

	it("rejects NaN owner_block_num", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner_block_num: Number.NaN })).toThrow(/NftStateRow\.owner_block_num/);
	});

	it("rejects negative owner_block_num", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner_block_num: -1 })).toThrow(/NftStateRow\.owner_block_num/);
	});

	it("rejects non-integer owner_block_num", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner_block_num: 1.5 })).toThrow(/NftStateRow\.owner_block_num/);
	});

	it("rejects undefined owner_block_num", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner_block_num: undefined })).toThrow(/NftStateRow\.owner_block_num/);
	});

	it("rejects non-numeric string owner_block_num", () => {
		expect(() => parseNftStateRow({ ...validRow(), owner_block_num: "not-a-number" })).toThrow(/NftStateRow\.owner_block_num/);
	});
});
