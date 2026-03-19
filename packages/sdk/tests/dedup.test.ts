import { test, expect, describe } from "bun:test";
import {
	validateArtId,
	validateArtIdArray,
	deterministicHash,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
} from "../src/dna";

describe("artId validation", () => {
	test("validates correct artId", () => {
		expect(validateArtId("gen-001")).toEqual({ valid: true });
		expect(validateArtId("myart123")).toEqual({ valid: true });
		expect(validateArtId("CAPS-ok")).toEqual({ valid: true });
		expect(validateArtId("a")).toEqual({ valid: true });
		expect(validateArtId("12345")).toEqual({ valid: true });
	});

	test("rejects empty artId", () => {
		expect(validateArtId("")).toEqual({ valid: false, error: "artId is required" });
	});

	test("rejects artId longer than 14 chars", () => {
		expect(validateArtId("this-is-too-long")).toEqual({ valid: false, error: "maximum 14 characters" });
		expect(validateArtId("12345678901234")).toEqual({ valid: true }); // exactly 14
		expect(validateArtId("123456789012345")).toEqual({ valid: false, error: "maximum 14 characters" }); // 15
	});

	test("rejects invalid characters", () => {
		expect(validateArtId("no spaces")).toEqual({ valid: false, error: "only letters, numbers and hyphens allowed" });
		expect(validateArtId("no_underscore")).toEqual({ valid: false, error: "only letters, numbers and hyphens allowed" });
		expect(validateArtId("no.dots")).toEqual({ valid: false, error: "only letters, numbers and hyphens allowed" });
		expect(validateArtId("no@special")).toEqual({ valid: false, error: "only letters, numbers and hyphens allowed" });
	});

	test("rejects repeated hyphens", () => {
		expect(validateArtId("bad--id")).toEqual({ valid: false, error: "repeated hyphens not allowed" });
		expect(validateArtId("a---b")).toEqual({ valid: false, error: "repeated hyphens not allowed" });
	});

	test("rejects leading/trailing hyphens", () => {
		expect(validateArtId("-leadhyphen")).toEqual({ valid: false, error: "cannot start or end with hyphen" });
		expect(validateArtId("trailhyphen-")).toEqual({ valid: false, error: "cannot start or end with hyphen" });
		expect(validateArtId("-both-")).toEqual({ valid: false, error: "cannot start or end with hyphen" });
	});
});

describe("artId array validation", () => {
	test("validates array of correct artIds", () => {
		const result = validateArtIdArray(["gen-001", "gen-002", "gen-003"]);
		expect(result.valid).toBe(true);
		expect(result.formatErrors).toHaveLength(0);
		expect(result.duplicates).toHaveLength(0);
	});

	test("detects format errors in array", () => {
		const result = validateArtIdArray(["gen-001", "bad--id", "gen-003"]);
		expect(result.valid).toBe(false);
		expect(result.formatErrors).toHaveLength(1);
		expect(result.formatErrors[0]!.index).toBe(1);
		expect(result.formatErrors[0]!.artId).toBe("bad--id");
	});

	test("detects duplicate artIds", () => {
		const result = validateArtIdArray(["gen-001", "gen-002", "gen-001"]);
		expect(result.valid).toBe(false);
		expect(result.duplicates).toContain("gen-001");
	});

	test("detects duplicates case-insensitively", () => {
		const result = validateArtIdArray(["Gen-001", "GEN-001"]);
		expect(result.valid).toBe(false);
		expect(result.duplicates).toHaveLength(1);
	});
});

describe("deterministic hash", () => {
	test("produces consistent results", () => {
		const input = "test-input-string";
		const hash1 = deterministicHash(input);
		const hash2 = deterministicHash(input);
		expect(hash1).toBe(hash2);
	});

	test("produces different results for different inputs", () => {
		const hash1 = deterministicHash("input-a");
		const hash2 = deterministicHash("input-b");
		expect(hash1).not.toBe(hash2);
	});

	test("returns at least 12 characters", () => {
		const hash = deterministicHash("short");
		expect(hash.length).toBeGreaterThanOrEqual(12);
	});
});

describe("deterministic collection ID", () => {
	test("generates consistent collectionId", () => {
		const id1 = generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		const id2 = generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		expect(id1).toBe(id2);
	});

	test("is case-insensitive for creator", () => {
		const id1 = generateDeterministicCollectionId("Creator", "My Collection", "MYCOL");
		const id2 = generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		expect(id1).toBe(id2);
	});

	test("normalizes symbol to uppercase", () => {
		const id1 = generateDeterministicCollectionId("creator", "My Collection", "mycol");
		const id2 = generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		expect(id1).toBe(id2);
	});

	test("generates different IDs for different inputs", () => {
		const id1 = generateDeterministicCollectionId("creator1", "Collection", "COL");
		const id2 = generateDeterministicCollectionId("creator2", "Collection", "COL");
		expect(id1).not.toBe(id2);
	});

	test("starts with col_ prefix", () => {
		const id = generateDeterministicCollectionId("creator", "Name", "SYM");
		expect(id.startsWith("col_")).toBe(true);
	});
});

describe("deterministic seed ID", () => {
	test("generates consistent seedId", () => {
		const id1 = generateDeterministicSeedId("col_abc123", "gen-001");
		const id2 = generateDeterministicSeedId("col_abc123", "gen-001");
		expect(id1).toBe(id2);
	});

	test("is case-insensitive for artId", () => {
		const id1 = generateDeterministicSeedId("col_abc123", "Gen-001");
		const id2 = generateDeterministicSeedId("col_abc123", "gen-001");
		expect(id1).toBe(id2);
	});

	test("generates different IDs for different artIds", () => {
		const id1 = generateDeterministicSeedId("col_abc123", "gen-001");
		const id2 = generateDeterministicSeedId("col_abc123", "gen-002");
		expect(id1).not.toBe(id2);
	});

	test("generates different IDs for different collections", () => {
		const id1 = generateDeterministicSeedId("col_abc123", "gen-001");
		const id2 = generateDeterministicSeedId("col_xyz789", "gen-001");
		expect(id1).not.toBe(id2);
	});

	test("starts with seed_ prefix", () => {
		const id = generateDeterministicSeedId("col_abc123", "gen-001");
		expect(id.startsWith("seed_")).toBe(true);
	});
});

describe("deterministic instance ID", () => {
	test("generates consistent instanceId", () => {
		const id1 = generateDeterministicInstanceId("seed_abc123", 1);
		const id2 = generateDeterministicInstanceId("seed_abc123", 1);
		expect(id1).toBe(id2);
	});

	test("generates different IDs for different instance numbers", () => {
		const id1 = generateDeterministicInstanceId("seed_abc123", 1);
		const id2 = generateDeterministicInstanceId("seed_abc123", 2);
		expect(id1).not.toBe(id2);
	});

	test("generates different IDs for different seeds", () => {
		const id1 = generateDeterministicInstanceId("seed_abc123", 1);
		const id2 = generateDeterministicInstanceId("seed_xyz789", 1);
		expect(id1).not.toBe(id2);
	});

	test("starts with nft_ prefix", () => {
		const id = generateDeterministicInstanceId("seed_abc123", 1);
		expect(id.startsWith("nft_")).toBe(true);
	});

	test("contains instance number", () => {
		const id = generateDeterministicInstanceId("seed_abc123", 42);
		expect(id).toContain("_42_");
	});
});

describe("full deduplication flow", () => {
	test("same JSON always produces same IDs", () => {
		const creator = "testuser";
		const collectionName = "Test Collection";
		const symbol = "TEST";
		const artIds = ["art-001", "art-002", "art-003"];

		// First generation
		const colId1 = generateDeterministicCollectionId(creator, collectionName, symbol);
		const seedIds1 = artIds.map(artId => generateDeterministicSeedId(colId1, artId));

		// Second generation (same inputs)
		const colId2 = generateDeterministicCollectionId(creator, collectionName, symbol);
		const seedIds2 = artIds.map(artId => generateDeterministicSeedId(colId2, artId));

		expect(colId1).toBe(colId2);
		expect(seedIds1).toEqual(seedIds2);
	});

	test("different artIds produce different seedIds in same collection", () => {
		const colId = generateDeterministicCollectionId("user", "Collection", "COL");
		const seedId1 = generateDeterministicSeedId(colId, "unique-a");
		const seedId2 = generateDeterministicSeedId(colId, "unique-b");

		expect(seedId1).not.toBe(seedId2);
	});
});
