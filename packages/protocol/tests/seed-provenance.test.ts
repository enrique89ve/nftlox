import { describe, test, expect } from "bun:test";
import {
	readDeclaredProvenance,
	assertProvenanceTarget,
	matchProvenance,
} from "../src/index.ts";

describe("readDeclaredProvenance", () => {
	test("returns undefined when both fields are absent", () => {
		expect(readDeclaredProvenance({})).toBeUndefined();
		expect(readDeclaredProvenance({ nftId: "nft_1", to: "bob" })).toBeUndefined();
	});

	test("treats explicit undefined / null as absent", () => {
		expect(readDeclaredProvenance({ seedId: undefined })).toBeUndefined();
		expect(readDeclaredProvenance({ seedTxId: undefined })).toBeUndefined();
		expect(readDeclaredProvenance({ seedId: null, seedTxId: null })).toBeUndefined();
	});

	test("returns seedId when only seedId is declared", () => {
		expect(readDeclaredProvenance({ seedId: "seed_abc" })).toEqual({
			seedId: "seed_abc",
		});
	});

	test("returns seedTxId when only seedTxId is declared", () => {
		expect(readDeclaredProvenance({ seedTxId: "tx123" })).toEqual({
			seedTxId: "tx123",
		});
	});

	test("returns both fields when both are declared", () => {
		expect(
			readDeclaredProvenance({ seedId: "seed_abc", seedTxId: "tx123" }),
		).toEqual({ seedId: "seed_abc", seedTxId: "tx123" });
	});

	test("ignores unknown extra fields", () => {
		expect(
			readDeclaredProvenance({
				seedId: "seed_abc",
				nftId: "nft_1",
				extra: { nested: true },
			}),
		).toEqual({ seedId: "seed_abc" });
	});

	test("rejects non-string seedId", () => {
		expect(() => readDeclaredProvenance({ seedId: 123 })).toThrow(
			"seedId must be a string when provided",
		);
		expect(() => readDeclaredProvenance({ seedId: true })).toThrow(
			"seedId must be a string when provided",
		);
		expect(() => readDeclaredProvenance({ seedId: { id: "x" } })).toThrow(
			"seedId must be a string when provided",
		);
		expect(() => readDeclaredProvenance({ seedId: ["x"] })).toThrow(
			"seedId must be a string when provided",
		);
	});

	test("rejects non-string seedTxId", () => {
		expect(() => readDeclaredProvenance({ seedTxId: 0 })).toThrow(
			"seedTxId must be a string when provided",
		);
	});

	test("rejects empty-string seedId", () => {
		expect(() => readDeclaredProvenance({ seedId: "" })).toThrow(
			"seedId must be a non-empty string when provided",
		);
	});

	test("rejects empty-string seedTxId", () => {
		expect(() => readDeclaredProvenance({ seedTxId: "" })).toThrow(
			"seedTxId must be a non-empty string when provided",
		);
	});
});

describe("assertProvenanceTarget", () => {
	test("accepts attestation on instance NFTs", () => {
		expect(() =>
			assertProvenanceTarget({ seedId: "seed_abc" }, "instance"),
		).not.toThrow();
	});

	test("rejects any attestation on a seed NFT", () => {
		expect(() =>
			assertProvenanceTarget({ seedId: "seed_abc" }, "seed"),
		).toThrow("Seed provenance cannot be declared on a seed NFT");

		expect(() =>
			assertProvenanceTarget({ seedTxId: "tx123" }, "seed"),
		).toThrow("Seed provenance cannot be declared on a seed NFT");

		expect(() =>
			assertProvenanceTarget(
				{ seedId: "seed_abc", seedTxId: "tx123" },
				"seed",
			),
		).toThrow("Seed provenance cannot be declared on a seed NFT");
	});
});

describe("matchProvenance", () => {
	test("passes when no field is declared", () => {
		expect(() =>
			matchProvenance({}, { seedId: "seed_a", seedCreatedTxId: "tx1" }),
		).not.toThrow();
	});

	test("passes when declared seedId matches actual", () => {
		expect(() =>
			matchProvenance(
				{ seedId: "seed_a" },
				{ seedId: "seed_a", seedCreatedTxId: null },
			),
		).not.toThrow();
	});

	test("rejects when declared seedId does not match actual", () => {
		expect(() =>
			matchProvenance(
				{ seedId: "seed_wrong" },
				{ seedId: "seed_a", seedCreatedTxId: null },
			),
		).toThrow(/Declared seedId 'seed_wrong' does not match actual 'seed_a'/);
	});

	test("rejects when actual seedId is null but seedId was declared", () => {
		expect(() =>
			matchProvenance(
				{ seedId: "seed_a" },
				{ seedId: null, seedCreatedTxId: null },
			),
		).toThrow(/Declared seedId 'seed_a' does not match actual 'null'/);
	});

	test("passes when declared seedTxId matches actual createdTxId", () => {
		expect(() =>
			matchProvenance(
				{ seedTxId: "tx1" },
				{ seedId: "seed_a", seedCreatedTxId: "tx1" },
			),
		).not.toThrow();
	});

	test("rejects when declared seedTxId does not match actual createdTxId", () => {
		expect(() =>
			matchProvenance(
				{ seedTxId: "tx_wrong" },
				{ seedId: "seed_a", seedCreatedTxId: "tx1" },
			),
		).toThrow(/Declared seedTxId 'tx_wrong' does not match actual 'tx1'/);
	});

	test("rejects seedTxId attestation when actual createdTxId is null (no parent seed)", () => {
		expect(() =>
			matchProvenance(
				{ seedTxId: "tx1" },
				{ seedId: null, seedCreatedTxId: null },
			),
		).toThrow("Cannot validate seedTxId: NFT has no parent seed");
	});

	test("validates both fields independently when both declared", () => {
		expect(() =>
			matchProvenance(
				{ seedId: "seed_a", seedTxId: "tx1" },
				{ seedId: "seed_a", seedCreatedTxId: "tx1" },
			),
		).not.toThrow();

		// seedId mismatches but seedTxId matches → still rejected on seedId
		expect(() =>
			matchProvenance(
				{ seedId: "seed_wrong", seedTxId: "tx1" },
				{ seedId: "seed_a", seedCreatedTxId: "tx1" },
			),
		).toThrow(/Declared seedId/);
	});
});
