import { test, expect, describe } from "bun:test";
import {
	sanitizeArtId,
	generateArtIdFromName,
	validateArtId,
	validateArtIdArray,
	generateHash,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
} from "../src/dna";

describe("sanitizeArtId", () => {
	test("trims whitespace", () => {
		expect(sanitizeArtId("  gen-001  ")).toBe("gen-001");
	});

	test("converts to lowercase", () => {
		expect(sanitizeArtId("MyCard-001")).toBe("mycard-001");
		expect(sanitizeArtId("EPIC-HERO")).toBe("epic-hero");
	});

	test("replaces spaces with hyphens", () => {
		expect(sanitizeArtId("common card 001")).toBe("common-card-001");
		expect(sanitizeArtId("my  art")).toBe("my-art");
	});

	test("replaces underscores with hyphens", () => {
		expect(sanitizeArtId("my_art_id")).toBe("my-art-id");
	});

	test("strips special characters", () => {
		expect(sanitizeArtId("art!@#$%001")).toBe("art001");
		expect(sanitizeArtId("héro-ñoño")).toBe("hro-oo");
	});

	test("collapses repeated hyphens", () => {
		expect(sanitizeArtId("bad---art")).toBe("bad-art");
		expect(sanitizeArtId("a - - b")).toBe("a-b");
	});

	test("strips leading and trailing hyphens", () => {
		expect(sanitizeArtId("-start-")).toBe("start");
		expect(sanitizeArtId("---middle---")).toBe("middle");
	});

	test("handles combined edge cases", () => {
		expect(sanitizeArtId("  My Card #1!  ")).toBe("my-card-1");
		expect(sanitizeArtId("___test___")).toBe("test");
	});
});

describe("generateArtIdFromName", () => {
	test("generates slug with 2-char hex suffix", async () => {
		const artId = await generateArtIdFromName("Mythic King Odin");
		expect(artId).toMatch(/^mythic-king-odin-[a-f0-9]{2}$/);
	});

	test("is deterministic", async () => {
		const a = await generateArtIdFromName("Common Card #42");
		const b = await generateArtIdFromName("Common Card #42");
		expect(a).toBe(b);
	});

	test("different names with same slug get different suffixes", async () => {
		const a = await generateArtIdFromName("Card #1!");
		const b = await generateArtIdFromName("Card 1");
		// Both slugify to "card-1" but suffixes differ
		expect(a.startsWith("card-1-")).toBe(true);
		expect(b.startsWith("card-1-")).toBe(true);
		expect(a).not.toBe(b);
	});

	test("result passes validateArtId", async () => {
		const names = [
			"Epic Hero Thor",
			"Common Card #927",
			"Mythic King Odin #1",
			"Rare Spell Ragnarok",
		];
		for (const name of names) {
			const artId = await generateArtIdFromName(name);
			expect(validateArtId(artId).valid).toBe(true);
		}
	});

	test("truncates long names to fit 32 chars", async () => {
		const artId = await generateArtIdFromName("This Is A Very Long Card Name That Exceeds The Limit");
		expect(artId.length).toBeLessThanOrEqual(32);
		expect(validateArtId(artId).valid).toBe(true);
	});

	test("throws on empty name", async () => {
		expect(generateArtIdFromName("")).rejects.toThrow("Name is required");
		expect(generateArtIdFromName("   ")).rejects.toThrow("Name is required");
	});
});

describe("artId validation", () => {
	test("validates correct artId", () => {
		expect(validateArtId("gen-001")).toEqual({ valid: true });
		expect(validateArtId("myart123")).toEqual({ valid: true });
		expect(validateArtId("a")).toEqual({ valid: true });
		expect(validateArtId("12345")).toEqual({ valid: true });
		expect(validateArtId("common-card-0001")).toEqual({ valid: true });
		expect(validateArtId("mythic-hero-odin-01")).toEqual({ valid: true });
	});

	test("rejects uppercase (must be lowercase)", () => {
		expect(validateArtId("CAPS-bad")).toEqual({ valid: false, error: "only lowercase letters, numbers and hyphens allowed" });
		expect(validateArtId("Mixed")).toEqual({ valid: false, error: "only lowercase letters, numbers and hyphens allowed" });
	});

	test("rejects empty artId", () => {
		expect(validateArtId("")).toEqual({ valid: false, error: "artId is required" });
	});

	test("rejects artId longer than 32 chars", () => {
		expect(validateArtId("this-is-a-very-long-art-id-name-x")).toEqual({ valid: false, error: "maximum 32 characters" });
		expect(validateArtId("12345678901234567890123456789012")).toEqual({ valid: true }); // exactly 32
		expect(validateArtId("123456789012345678901234567890123")).toEqual({ valid: false, error: "maximum 32 characters" }); // 33
	});

	test("rejects invalid characters", () => {
		expect(validateArtId("has spaces")).toEqual({ valid: false, error: "only lowercase letters, numbers and hyphens allowed" });
		expect(validateArtId("under_score")).toEqual({ valid: false, error: "only lowercase letters, numbers and hyphens allowed" });
		expect(validateArtId("special!")).toEqual({ valid: false, error: "only lowercase letters, numbers and hyphens allowed" });
	});

	test("rejects artId starting or ending with hyphen", () => {
		expect(validateArtId("-start")).toEqual({ valid: false, error: "cannot start or end with hyphen" });
		expect(validateArtId("end-")).toEqual({ valid: false, error: "cannot start or end with hyphen" });
	});

	test("rejects consecutive hyphens", () => {
		expect(validateArtId("bad--art")).toEqual({ valid: false, error: "repeated hyphens not allowed" });
	});
});

describe("artId array validation", () => {
	test("validates correct array", () => {
		const result = validateArtIdArray(["art-001", "art-002", "art-003"]);
		expect(result.valid).toBe(true);
		expect(result.duplicates).toEqual([]);
		expect(result.formatErrors).toEqual([]);
	});

	test("detects duplicates (case-insensitive)", () => {
		const result = validateArtIdArray(["art-001", "art-001", "art-002"]);
		expect(result.valid).toBe(false);
		expect(result.duplicates).toContain("art-001");
	});

	test("detects format errors", () => {
		const result = validateArtIdArray(["valid-art", "bad art", "also--bad"]);
		expect(result.valid).toBe(false);
		expect(result.formatErrors.length).toBe(2);
	});
});

describe("SHA-256 hash", () => {
	test("produces consistent results", async () => {
		const input = "test-input-string";
		const hash1 = await generateHash(input);
		const hash2 = await generateHash(input);
		expect(hash1).toBe(hash2);
	});

	test("produces different results for different inputs", async () => {
		const hash1 = await generateHash("input-a");
		const hash2 = await generateHash("input-b");
		expect(hash1).not.toBe(hash2);
	});

	test("returns 64 hex characters (SHA-256)", async () => {
		const hash = await generateHash("short");
		expect(hash.length).toBe(64);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("deterministic collection ID", () => {
	test("generates consistent collectionId", async () => {
		const id1 = await generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		const id2 = await generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		expect(id1).toBe(id2);
	});

	test("is case-insensitive for creator", async () => {
		const id1 = await generateDeterministicCollectionId("Creator", "My Collection", "MYCOL");
		const id2 = await generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		expect(id1).toBe(id2);
	});

	test("normalizes symbol to uppercase", async () => {
		const id1 = await generateDeterministicCollectionId("creator", "My Collection", "mycol");
		const id2 = await generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		expect(id1).toBe(id2);
	});

	test("generates different IDs for different inputs", async () => {
		const id1 = await generateDeterministicCollectionId("creator1", "Collection", "COL");
		const id2 = await generateDeterministicCollectionId("creator2", "Collection", "COL");
		expect(id1).not.toBe(id2);
	});

	test("starts with col_ prefix", async () => {
		const id = await generateDeterministicCollectionId("creator", "Name", "SYM");
		expect(id.startsWith("col_")).toBe(true);
	});
});

describe("deterministic seed ID", () => {
	test("generates consistent seedId", async () => {
		const id1 = await generateDeterministicSeedId("col_abc123", "gen-001");
		const id2 = await generateDeterministicSeedId("col_abc123", "gen-001");
		expect(id1).toBe(id2);
	});

	test("is case-insensitive for artId", async () => {
		const id1 = await generateDeterministicSeedId("col_abc123", "Gen-001");
		const id2 = await generateDeterministicSeedId("col_abc123", "gen-001");
		expect(id1).toBe(id2);
	});

	test("generates different IDs for different artIds", async () => {
		const id1 = await generateDeterministicSeedId("col_abc123", "gen-001");
		const id2 = await generateDeterministicSeedId("col_abc123", "gen-002");
		expect(id1).not.toBe(id2);
	});

	test("generates different IDs for different collections", async () => {
		const id1 = await generateDeterministicSeedId("col_abc123", "gen-001");
		const id2 = await generateDeterministicSeedId("col_xyz789", "gen-001");
		expect(id1).not.toBe(id2);
	});

	test("starts with seed_ prefix", async () => {
		const id = await generateDeterministicSeedId("col_abc123", "gen-001");
		expect(id.startsWith("seed_")).toBe(true);
	});
});

describe("deterministic instance ID", () => {
	test("generates consistent instanceId", async () => {
		const id1 = await generateDeterministicInstanceId("seed_abc123", 1);
		const id2 = await generateDeterministicInstanceId("seed_abc123", 1);
		expect(id1).toBe(id2);
	});

	test("generates different IDs for different instance numbers", async () => {
		const id1 = await generateDeterministicInstanceId("seed_abc123", 1);
		const id2 = await generateDeterministicInstanceId("seed_abc123", 2);
		expect(id1).not.toBe(id2);
	});

	test("generates different IDs for different seeds", async () => {
		const id1 = await generateDeterministicInstanceId("seed_abc123", 1);
		const id2 = await generateDeterministicInstanceId("seed_xyz789", 1);
		expect(id1).not.toBe(id2);
	});

	test("starts with nft_ prefix", async () => {
		const id = await generateDeterministicInstanceId("seed_abc123", 1);
		expect(id.startsWith("nft_")).toBe(true);
	});

	test("ends with instance number", async () => {
		const id = await generateDeterministicInstanceId("seed_abc123", 42);
		expect(id.endsWith("_42")).toBe(true);
	});

	test("has three underscore-separated parts", async () => {
		const id = await generateDeterministicInstanceId("seed_abc123", 1);
		const parts = id.split("_");
		expect(parts.length).toBe(3);
		expect(parts[0]).toBe("nft");
		expect(parts[2]).toBe("1");
	});
});

describe("full deduplication flow", () => {
	test("same JSON always produces same IDs", async () => {
		const creator = "testuser";
		const collectionName = "Test Collection";
		const symbol = "TEST";
		const artIds = ["art-001", "art-002", "art-003"];

		const colId1 = await generateDeterministicCollectionId(creator, collectionName, symbol);
		const seedIds1 = await Promise.all(artIds.map(artId => generateDeterministicSeedId(colId1, artId)));

		const colId2 = await generateDeterministicCollectionId(creator, collectionName, symbol);
		const seedIds2 = await Promise.all(artIds.map(artId => generateDeterministicSeedId(colId2, artId)));

		expect(colId1).toBe(colId2);
		expect(seedIds1).toEqual(seedIds2);
	});

	test("different artIds produce different seedIds in same collection", async () => {
		const colId = await generateDeterministicCollectionId("user", "Collection", "COL");
		const seedId1 = await generateDeterministicSeedId(colId, "unique-a");
		const seedId2 = await generateDeterministicSeedId(colId, "unique-b");

		expect(seedId1).not.toBe(seedId2);
	});
});
