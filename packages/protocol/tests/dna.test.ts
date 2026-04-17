import { describe, test, expect } from "bun:test";
import {
	generateHash,
	generateOriginDna,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
	generateImageHash,
	isSeedId,
	isInstanceId,
	extractSeedId,
	generateListingNonce,
} from "../src/index.ts";

describe("DNA generation", () => {
	test("generateHash is deterministic", async () => {
		const a = await generateHash("test");
		const b = await generateHash("test");
		expect(a).toBe(b);
		expect(a.length).toBe(64);
	});

	test("generateOriginDna starts with 'o' and has correct length", async () => {
		const dna = await generateOriginDna("col_test123");
		expect(dna.startsWith("o")).toBe(true);
		expect(dna.length).toBe(16);
	});

	test("generateDeterministicCollectionId is deterministic", async () => {
		const a = await generateDeterministicCollectionId("alice", "Test", "TST");
		const b = await generateDeterministicCollectionId("alice", "Test", "TST");
		expect(a).toBe(b);
		expect(a.startsWith("col_")).toBe(true);
	});

	test("generateDeterministicSeedId is deterministic", async () => {
		const a = await generateDeterministicSeedId("col_abc", "art-001");
		const b = await generateDeterministicSeedId("col_abc", "art-001");
		expect(a).toBe(b);
		expect(a.startsWith("seed_")).toBe(true);
	});

	test("generateDeterministicInstanceId format", async () => {
		const seedId = await generateDeterministicSeedId("col_test", "art-001");
		const id = await generateDeterministicInstanceId(seedId, 1);
		expect(id.startsWith("nft_")).toBe(true);
		expect(id.endsWith("_1")).toBe(true);
		expect(id).toMatch(/^nft_[a-f0-9]{20}_\d+$/);
	});

	test("isSeedId / isInstanceId guards", async () => {
		const seedId = await generateDeterministicSeedId("col_abc", "art-001");
		const instanceId = await generateDeterministicInstanceId(seedId, 1);
		expect(isSeedId(seedId)).toBe(true);
		expect(isSeedId(instanceId)).toBe(false);
		expect(isInstanceId(instanceId)).toBe(true);
		expect(isInstanceId(seedId)).toBe(false);
	});

	test("extractSeedId round-trips", async () => {
		const seedId = await generateDeterministicSeedId("col_abc", "art-001");
		const instanceId = await generateDeterministicInstanceId(seedId, 5);
		expect(extractSeedId(instanceId)).toBe(seedId);
	});

	test("generateListingNonce is 12 chars", () => {
		const nonce = generateListingNonce();
		expect(nonce.length).toBe(12);
	});

	test("generateImageHash is deterministic", async () => {
		const a = await generateImageHash("https://example.com/img.png");
		const b = await generateImageHash("https://example.com/img.png");
		expect(a).toBe(b);
		expect(a.startsWith("img_")).toBe(true);
	});
});
