// NFTLox Seed & Instance ID Tests
import { test, expect, describe } from "bun:test";
import {
	generateSeedId,
	generateInstanceId,
	extractSeedId,
	extractInstanceNumber,
	isSeedId,
	isInstanceId,
} from "../src/dna";

describe("Seed ID Generation", () => {
	test("generateSeedId returns format seed_[8chars]", () => {
		const seedId = generateSeedId();
		expect(seedId).toMatch(/^seed_[a-z0-9]{8}$/);
	});

	test("generateSeedId generates unique IDs", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(generateSeedId());
		}
		expect(ids.size).toBe(100);
	});
});

describe("Instance ID Generation", () => {
	test("generateInstanceId returns format nft_[seedSuffix]_[N]_[4chars]", () => {
		const instanceId = generateInstanceId("seed_abcd1234", 1);
		expect(instanceId).toMatch(/^nft_abcd1234_1_[a-z0-9]{4}$/);
	});

	test("generateInstanceId includes instance number", () => {
		const id1 = generateInstanceId("seed_test1234", 1);
		const id5 = generateInstanceId("seed_test1234", 5);
		const id99 = generateInstanceId("seed_test1234", 99);

		expect(id1).toContain("_1_");
		expect(id5).toContain("_5_");
		expect(id99).toContain("_99_");
	});

	test("generateInstanceId generates unique random suffixes", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) {
			ids.add(generateInstanceId("seed_test1234", 1));
		}
		expect(ids.size).toBe(50);
	});
});

describe("Extract Seed ID", () => {
	test("extractSeedId extracts seed from valid instance ID", () => {
		const seedId = extractSeedId("nft_abc12345_1_xy7z");
		expect(seedId).toBe("seed_abc12345");
	});

	test("extractSeedId handles different instance numbers", () => {
		expect(extractSeedId("nft_test1234_1_abcd")).toBe("seed_test1234");
		expect(extractSeedId("nft_test1234_99_abcd")).toBe("seed_test1234");
		expect(extractSeedId("nft_test1234_999_abcd")).toBe("seed_test1234");
	});

	test("extractSeedId returns null for non-instance IDs", () => {
		expect(extractSeedId("nft_m8n2abc123")).toBeNull();
		expect(extractSeedId("seed_abc12345")).toBeNull();
		expect(extractSeedId("random_string")).toBeNull();
		expect(extractSeedId("")).toBeNull();
	});
});

describe("Extract Instance Number", () => {
	test("extractInstanceNumber extracts number from valid instance ID", () => {
		const num = extractInstanceNumber("nft_abc12345_1_xy7z");
		expect(num).toBe(1);
	});

	test("extractInstanceNumber handles various numbers", () => {
		expect(extractInstanceNumber("nft_test1234_1_abcd")).toBe(1);
		expect(extractInstanceNumber("nft_test1234_42_abcd")).toBe(42);
		expect(extractInstanceNumber("nft_test1234_999_abcd")).toBe(999);
	});

	test("extractInstanceNumber returns null for non-instance IDs", () => {
		expect(extractInstanceNumber("nft_m8n2abc123")).toBeNull();
		expect(extractInstanceNumber("seed_abc12345")).toBeNull();
		expect(extractInstanceNumber("random_string")).toBeNull();
	});
});

describe("isSeedId", () => {
	test("returns true for seed IDs", () => {
		expect(isSeedId("seed_abc12345")).toBe(true);
		expect(isSeedId("seed_")).toBe(true);
		expect(isSeedId("seed_12345678")).toBe(true);
	});

	test("returns false for non-seed IDs", () => {
		expect(isSeedId("nft_abc12345_1_xy7z")).toBe(false);
		expect(isSeedId("nft_m8n2abc123")).toBe(false);
		expect(isSeedId("col_abc123")).toBe(false);
		expect(isSeedId("")).toBe(false);
	});
});

describe("isInstanceId", () => {
	test("returns true for instance IDs", () => {
		expect(isInstanceId("nft_abc12345_1_xy7z")).toBe(true);
		expect(isInstanceId("nft_test1234_99_abcd")).toBe(true);
		expect(isInstanceId("nft_a1b2c3d4_1_x1y2")).toBe(true);
	});

	test("returns false for non-instance IDs", () => {
		expect(isInstanceId("seed_abc12345")).toBe(false);
		expect(isInstanceId("nft_m8n2abc123")).toBe(false);
		expect(isInstanceId("nft_abc_1")).toBe(false);
		expect(isInstanceId("col_abc123")).toBe(false);
		expect(isInstanceId("")).toBe(false);
	});
});

describe("Round-trip conversion", () => {
	test("seed ID can be extracted from generated instance ID", () => {
		const seedId = "seed_abcd1234";
		const instanceId = generateInstanceId(seedId, 5);
		const extractedSeed = extractSeedId(instanceId);
		expect(extractedSeed).toBe(seedId);
	});

	test("instance number can be extracted from generated instance ID", () => {
		const seedId = "seed_test1234";
		const instanceNumber = 42;
		const instanceId = generateInstanceId(seedId, instanceNumber);
		const extractedNumber = extractInstanceNumber(instanceId);
		expect(extractedNumber).toBe(instanceNumber);
	});
});
