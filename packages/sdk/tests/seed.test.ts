// NFTLox Seed & Instance ID Tests
import { test, expect, describe } from "bun:test";
import {
	generateInstanceId,
	generateDeterministicSeedId,
	extractSeedId,
	extractInstanceNumber,
	isSeedId,
	isInstanceId,
} from "../src/dna";

describe("Instance ID Generation", () => {
	test("generateInstanceId returns format nft_[20hex]_[N]", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "dragon-fire");
		const instanceId = await generateInstanceId(seedId, 1);
		expect(instanceId).toMatch(/^nft_[a-f0-9]{20}_1$/);
	});

	test("generateInstanceId includes instance number", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		const id1 = await generateInstanceId(seedId, 1);
		const id5 = await generateInstanceId(seedId, 5);
		const id99 = await generateInstanceId(seedId, 99);

		expect(id1.endsWith("_1")).toBe(true);
		expect(id5.endsWith("_5")).toBe(true);
		expect(id99.endsWith("_99")).toBe(true);
	});

	test("generateInstanceId is deterministic", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		const id1 = await generateInstanceId(seedId, 1);
		const id2 = await generateInstanceId(seedId, 1);
		expect(id1).toBe(id2);
	});

	test("generateInstanceId differs by instance number", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		const ids = new Set<string>();
		for (let i = 1; i <= 50; i++) {
			ids.add(await generateInstanceId(seedId, i));
		}
		expect(ids.size).toBe(50);
	});

	test("seed-derived hash is 20 hex characters", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		const instanceId = await generateInstanceId(seedId, 1);
		const parts = instanceId.split("_");
		expect(parts.length).toBe(3);
		expect(parts[1]).toMatch(/^[a-f0-9]{20}$/);
	});
});

describe("Seed ID Format", () => {
	test("starts with seed_ prefix and has 20 hex chars", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "dragon-fire");
		expect(seedId.startsWith("seed_")).toBe(true);
		const hashPart = seedId.slice(5);
		expect(hashPart.length).toBe(20);
		expect(hashPart).toMatch(/^[a-f0-9]{20}$/);
	});
});

describe("Extract Seed ID", () => {
	test("extractSeedId extracts seed from generated instance ID", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "dragon-fire");
		const instanceId = await generateInstanceId(seedId, 5);
		const extracted = extractSeedId(instanceId);
		expect(extracted).toBe(seedId);
	});

	test("extractSeedId handles different instance numbers", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		for (const num of [1, 99, 999]) {
			const instanceId = await generateInstanceId(seedId, num);
			expect(extractSeedId(instanceId)).toBe(seedId);
		}
	});

	test("extractSeedId returns null for non-instance IDs", () => {
		expect(extractSeedId("seed_abc12345_abcdef123456")).toBeNull();
		expect(extractSeedId("random_string")).toBeNull();
		expect(extractSeedId("")).toBeNull();
	});
});

describe("Extract Instance Number", () => {
	test("extractInstanceNumber from generated instance ID", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		const instanceId = await generateInstanceId(seedId, 42);
		expect(extractInstanceNumber(instanceId)).toBe(42);
	});

	test("extractInstanceNumber handles various numbers", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		for (const num of [1, 42, 999]) {
			const instanceId = await generateInstanceId(seedId, num);
			expect(extractInstanceNumber(instanceId)).toBe(num);
		}
	});

	test("extractInstanceNumber returns null for non-instance IDs", () => {
		expect(extractInstanceNumber("seed_abc_abcdef123456")).toBeNull();
		expect(extractInstanceNumber("random_string")).toBeNull();
	});
});

describe("isSeedId", () => {
	test("returns true for seed IDs", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		expect(isSeedId(seedId)).toBe(true);
		expect(isSeedId("seed_")).toBe(true);
	});

	test("returns false for non-seed IDs", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		const instanceId = await generateInstanceId(seedId, 1);
		expect(isSeedId(instanceId)).toBe(false);
		expect(isSeedId("col_abc123")).toBe(false);
		expect(isSeedId("")).toBe(false);
	});
});

describe("isInstanceId", () => {
	test("returns true for generated instance IDs", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		const instanceId = await generateInstanceId(seedId, 1);
		expect(isInstanceId(instanceId)).toBe(true);
	});

	test("returns false for non-instance IDs", () => {
		expect(isInstanceId("seed_abc_abcdef123456")).toBe(false);
		expect(isInstanceId("col_abc123")).toBe(false);
		expect(isInstanceId("")).toBe(false);
	});
});

describe("Round-trip conversion", () => {
	test("seed ID can be extracted from generated instance ID", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "dragon-fire");
		const instanceId = await generateInstanceId(seedId, 5);
		expect(extractSeedId(instanceId)).toBe(seedId);
	});

	test("instance number can be extracted from generated instance ID", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-01");
		const instanceId = await generateInstanceId(seedId, 42);
		expect(extractInstanceNumber(instanceId)).toBe(42);
	});
});
