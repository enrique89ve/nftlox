import { describe, test, expect } from "bun:test";
import {
	generateHash,
	generateOriginDna,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
	generateImageHash,
	generateListingId,
	isSeedId,
	isInstanceId,
	isListingId,
	isHiveTxId,
	isSymbol,
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

	test("isListingId guard", async () => {
		const listingId = await generateListingId({
			nftId: "nft_aaaaaaaaaaaaaaaaaaaa_1",
			owner: "alice",
			marketplace: "nftlox",
			priceAmount: "1.000",
			priceCurrency: "HIVE",
			expiresAt: 1_700_000_000_000,
			nonce: "abcdef012345",
		});
		expect(isListingId(listingId)).toBe(true);
		// Rejects: wrong prefix, wrong charset, wrong length, missing prefix.
		expect(isListingId("listing_abcd")).toBe(false);
		expect(isListingId(`list_${"Z".repeat(32)}`)).toBe(false);
		expect(isListingId(`list_${"a".repeat(31)}`)).toBe(false);
		expect(isListingId(`list_${"a".repeat(33)}`)).toBe(false);
		expect(isListingId("a".repeat(37))).toBe(false);
	});

	test("isSymbol guard", () => {
		// Canonical: 3-10 uppercase chars, leading letter, A-Z0-9 in tail.
		expect(isSymbol("CARD")).toBe(true);
		expect(isSymbol("NFT01")).toBe(true);
		expect(isSymbol("ABC")).toBe(true);
		expect(isSymbol("A1B2C3D4E5")).toBe(true);
		// Rejects: lowercase, leading digit, too short, too long, empty, bad chars.
		expect(isSymbol("card")).toBe(false);
		expect(isSymbol("1ABC")).toBe(false);
		expect(isSymbol("AB")).toBe(false);
		expect(isSymbol("A".repeat(11))).toBe(false);
		expect(isSymbol("")).toBe(false);
		expect(isSymbol("AB-CD")).toBe(false);
		expect(isSymbol("AB CD")).toBe(false);
	});

	test("isHiveTxId guard", () => {
		// 40 lowercase hex — the canonical Hive tx id shape.
		expect(isHiveTxId("a".repeat(40))).toBe(true);
		expect(isHiveTxId("0123456789abcdef0123456789abcdef01234567")).toBe(true);
		// Rejects: wrong case, wrong length, non-hex chars.
		expect(isHiveTxId("A".repeat(40))).toBe(false);
		expect(isHiveTxId("a".repeat(39))).toBe(false);
		expect(isHiveTxId("a".repeat(41))).toBe(false);
		expect(isHiveTxId("g".repeat(40))).toBe(false);
		expect(isHiveTxId("")).toBe(false);
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

	// NFC normalization lives inside `toWireUrl` so any third-party indexer
	// reproducing image-hash derivation must apply NFC before hashing the URL.
	test("NFC and NFD image URLs map to the same image id", async () => {
		const fromNfc = await generateImageHash(`https://example.com/${NFC_NAIVE}.png`);
		const fromNfd = await generateImageHash(`https://example.com/${NFD_NAIVE}.png`);
		expect(fromNfc).toBe(fromNfd);
		expect(fromNfc).toBe("img_090e5c2b65c65667");
	});
});
