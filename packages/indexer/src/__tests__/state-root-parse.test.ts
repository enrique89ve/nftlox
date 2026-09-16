import { describe, it, expect } from "bun:test";
import { parseAssetStateRow } from "@/db/queries/state-root.ts";

const validRow = () => ({
	id: "asset-1",
	owner: "alice",
	previous_owner: "bob",
	owner_action: "transfer",
	owner_operation_id: "op-1",
	owner_block_num: 100,
});

describe("parseAssetStateRow", () => {
	it("parses a well-formed row", () => {
		const parsed = parseAssetStateRow(validRow());
		expect(parsed).toEqual({
			id: "asset-1",
			owner: "alice",
			previous_owner: "bob",
			owner_action: "transfer",
			owner_operation_id: "op-1",
			owner_block_num: 100,
		});
	});

	it("accepts previous_owner === null", () => {
		const parsed = parseAssetStateRow({ ...validRow(), previous_owner: null });
		expect(parsed.previous_owner).toBeNull();
	});

	it("accepts bigint-string owner_block_num (postgres.js default for int8)", () => {
		const parsed = parseAssetStateRow({ ...validRow(), owner_block_num: "12345" });
		expect(parsed.owner_block_num).toBe(12345);
	});

	it("accepts native bigint owner_block_num", () => {
		const parsed = parseAssetStateRow({ ...validRow(), owner_block_num: 42n });
		expect(parsed.owner_block_num).toBe(42);
	});

	it("rejects null id", () => {
		expect(() => parseAssetStateRow({ ...validRow(), id: null })).toThrow(/AssetStateRow\.id/);
	});

	it("rejects empty id", () => {
		expect(() => parseAssetStateRow({ ...validRow(), id: "" })).toThrow(/AssetStateRow\.id/);
	});

	it("rejects null owner", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner: null })).toThrow(/AssetStateRow\.owner/);
	});

	it("rejects empty owner", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner: "" })).toThrow(/AssetStateRow\.owner/);
	});

	it("rejects non-string previous_owner (e.g. number)", () => {
		expect(() => parseAssetStateRow({ ...validRow(), previous_owner: 42 })).toThrow(/AssetStateRow\.previous_owner/);
	});

	it("rejects empty-string previous_owner (null is the right sentinel)", () => {
		expect(() => parseAssetStateRow({ ...validRow(), previous_owner: "" })).toThrow(/AssetStateRow\.previous_owner/);
	});

	it("rejects null owner_action", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner_action: null })).toThrow(/AssetStateRow\.owner_action/);
	});

	it("rejects null owner_operation_id", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner_operation_id: null })).toThrow(/AssetStateRow\.owner_operation_id/);
	});

	it("rejects NaN owner_block_num", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner_block_num: Number.NaN })).toThrow(/AssetStateRow\.owner_block_num/);
	});

	it("rejects negative owner_block_num", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner_block_num: -1 })).toThrow(/AssetStateRow\.owner_block_num/);
	});

	it("rejects non-integer owner_block_num", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner_block_num: 1.5 })).toThrow(/AssetStateRow\.owner_block_num/);
	});

	it("rejects undefined owner_block_num", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner_block_num: undefined })).toThrow(/AssetStateRow\.owner_block_num/);
	});

	it("rejects non-numeric string owner_block_num", () => {
		expect(() => parseAssetStateRow({ ...validRow(), owner_block_num: "not-a-number" })).toThrow(/AssetStateRow\.owner_block_num/);
	});
});
