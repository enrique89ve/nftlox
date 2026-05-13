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

// Frozen-vector suite — pins the EXACT byte-level output of every helper whose
// result is observed on-chain or persisted to the DB. Idempotency tests above
// are circular (both sides call the same helper); these vectors are the only
// cross-implementation contract a Rust/Go indexer can target.
//
// Regenerating a vector means the underlying hash-domain constant, prefix, or
// slice length changed — that is a hardfork. A paired ADR + on-chain migration
// note is required before updating these strings.
describe("DNA frozen vectors (cross-implementation contract)", () => {
	test("generateHash('test')", async () => {
		expect(await generateHash("test")).toBe(
			"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		);
	});

	test("generateOriginDna('col_test123')", async () => {
		expect(await generateOriginDna("col_test123")).toBe("oEE1780215BA2FAB");
	});

	test("generateDeterministicCollectionId('alice','Test','TST')", async () => {
		expect(await generateDeterministicCollectionId("alice", "Test", "TST")).toBe(
			"col_c68ff3c9d182617bf2d0",
		);
	});

	test("generateDeterministicSeedId('col_abc','art-001')", async () => {
		expect(await generateDeterministicSeedId("col_abc", "art-001")).toBe(
			"seed_8632f01162b516dea169",
		);
	});

	test("generateImageHash('https://example.com/img.png')", async () => {
		expect(await generateImageHash("https://example.com/img.png")).toBe(
			"img_c035880b799db97a",
		);
	});
});

// Adversarial Unicode parity — defends [[project_protocol_hash_inputs_must_be_normalized]].
// Two strings rendering as the same glyph sequence but encoded in different
// Unicode normalization forms (NFC pre-composed vs NFD decomposed) MUST hash
// to the same canonical id. Without normalization inside the helpers, the same
// "naïve" name typed on Android (NFD) and Desktop (NFC) would map to two
// distinct on-chain collections.
describe("DNA helpers normalize Unicode inputs", () => {
	// "naïve" with the LATIN SMALL LETTER I WITH DIAERESIS (U+00EF), 5 JS chars.
	const NFC_NAIVE = "naïve";
	// "naïve" with i (U+0069) + COMBINING DIAERESIS (U+0308), 6 JS chars.
	const NFD_NAIVE = "naïve";

	test("NFC and NFD names map to the same collection id", async () => {
		const fromNfc = await generateDeterministicCollectionId("alice", NFC_NAIVE, "TST");
		const fromNfd = await generateDeterministicCollectionId("alice", NFD_NAIVE, "TST");
		expect(fromNfc).toBe(fromNfd);
		expect(fromNfc).toBe("col_f273a696068606611d65");
	});

	test("NFC and NFD artIds map to the same seed id", async () => {
		const fromNfc = await generateDeterministicSeedId("col_abc", `${NFC_NAIVE}-001`);
		const fromNfd = await generateDeterministicSeedId("col_abc", `${NFD_NAIVE}-001`);
		expect(fromNfc).toBe(fromNfd);
		expect(fromNfc).toBe("seed_54bc09b235b1c5274d2a");
	});
});
