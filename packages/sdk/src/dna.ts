// NFTLox DNA Generation Module
// Implements dual DNA system: originDna (collection) + instanceDna (individual NFT)

import { createHash } from "crypto";

import {
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACCESS_KEY_LENGTH,
	INSTANCE_ID_HASH_LENGTH,
	LISTING_ID_PREFIX,
	LISTING_NONCE_LENGTH,
	LISTING_HASH_LENGTH,
} from "./constants";

// ============ HASH FUNCTIONS ============

/**
 * SHA-256 hash using Web Crypto (crypto.subtle). Async.
 * Used for all identity generation (DNA, IDs, access keys, listing IDs).
 * Uses crypto.subtle for universal runtime support (browsers, Node 18+, Bun, Deno).
 *
 * Note: deterministicRng() uses sync crypto.createHash("sha256") instead,
 * because resolveDropTable() calls it in a tight loop and must stay synchronous.
 */
export async function generateHash(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}


// ============ ORIGIN DNA (Collection Level) ============

/**
 * Generates the origin DNA for a collection.
 * This DNA is shared by all NFTs in the collection (genetic thread).
 * DETERMINISTIC: Same collectionId always produces same originDna.
 */
export async function generateOriginDna(collectionId: string): Promise<string> {
	const input = `nftlox:origin:${collectionId}`;
	const fullHash = await generateHash(input);
	return "o" + fullHash.slice(0, ORIGIN_DNA_LENGTH - 1).toUpperCase();
}

// ============ INSTANCE DNA (NFT Level) ============

/**
 * Generates the instance DNA for an individual NFT.
 * DETERMINISTIC: SHA-256 of nftId + originDna + edition + imageHash.
 * Prefixed with "i" to identify as instance DNA.
 */
export async function generateInstanceDna(
	nftId: string,
	originDna: string,
	edition: number,
	imageHash: string,
): Promise<string> {
	const input = `nftlox:instance:${nftId}:${originDna}:${edition}:${imageHash}`;
	const fullHash = await generateHash(input);
	return "i" + fullHash.slice(0, INSTANCE_DNA_LENGTH - 1).toUpperCase();
}

/**
 * Generates instance DNA for a replica.
 * DETERMINISTIC: SHA-256 derived from original's DNA to maintain lineage.
 * Prefixed with "i" to identify as instance DNA.
 */
export async function generateReplicaInstanceDna(
	originDna: string,
	originalInstanceDna: string,
): Promise<string> {
	const input = `nftlox:replica:${originDna}:${originalInstanceDna}`;
	const fullHash = await generateHash(input);
	return "i" + fullHash.slice(0, INSTANCE_DNA_LENGTH - 1).toUpperCase();
}

// ============ ACCESS KEY ============

/**
 * Generates a unique access key for an NFT.
 * DETERMINISTIC: SHA-256 of instanceDna + owner.
 * Used for software activation, membership access, etc.
 */
export async function generateAccessKey(instanceDna: string, owner: string): Promise<string> {
	const input = `nftlox:accesskey:${instanceDna}:${owner}`;
	const fullHash = await generateHash(input);
	return fullHash.slice(0, ACCESS_KEY_LENGTH).toUpperCase();
}

// ============ IMAGE HASH ============

/**
 * Generates a hash for an image URL.
 * DETERMINISTIC: SHA-256 of the URL. Same URL always produces the same hash.
 */
export async function generateImageHash(imageUrl: string): Promise<string> {
	const input = `nftlox:img:${imageUrl}`;
	const fullHash = await generateHash(input);
	return `img_${fullHash.slice(0, 16)}`;
}

// ============ ID GENERATION ============

/**
 * Generates a deterministic replica ID from an original NFT ID.
 * Same originalId always produces the same replicaId.
 */
export async function generateReplicaId(originalId: string): Promise<string> {
	const hash = await generateHash(`nftlox:replica:${originalId}`);
	return `${originalId}_r${hash.slice(0, 8)}`;
}

/**
 * Extracts the original NFT ID from a replica ID.
 */
export function extractOriginalId(replicaId: string): string | null {
	const rIndex = replicaId.lastIndexOf("_r");
	if (rIndex === -1) return null;
	return replicaId.slice(0, rIndex);
}

/**
 * Checks if an ID is a replica ID.
 */
export function isReplicaId(id: string): boolean {
	return id.includes("_r");
}

// ============ SEED & INSTANCE IDS ============

/**
 * Generates a deterministic instance ID from a seed.
 * Format: nft_[seedSuffix]_[instanceNumber]_[hash]
 * Same seedId + instanceNumber always produces the same ID.
 */
export async function generateInstanceId(seedId: string, instanceNumber: number): Promise<string> {
	return await generateDeterministicInstanceId(seedId, instanceNumber);
}

/**
 * Extracts the seed ID from an instance ID.
 * Format: nft_[seedSuffix]_[N]_[20hex] → seed_[seedSuffix]
 * Parses from the end: last segment is hash, second-to-last is instance number.
 */
export function extractSeedId(instanceId: string): string | null {
	if (!instanceId.startsWith("nft_")) return null;
	const withoutPrefix = instanceId.slice(4);
	const lastUnderscore = withoutPrefix.lastIndexOf("_");
	if (lastUnderscore === -1) return null;
	const beforeHash = withoutPrefix.slice(0, lastUnderscore);
	const secondLastUnderscore = beforeHash.lastIndexOf("_");
	if (secondLastUnderscore === -1) return null;
	const instanceNum = beforeHash.slice(secondLastUnderscore + 1);
	if (!/^\d+$/.test(instanceNum)) return null;
	const seedSuffix = beforeHash.slice(0, secondLastUnderscore);
	return `seed_${seedSuffix}`;
}

/**
 * Extracts the instance number from an instance ID.
 * Format: nft_[seedSuffix]_[N]_[20hex]
 */
export function extractInstanceNumber(instanceId: string): number | null {
	if (!instanceId.startsWith("nft_")) return null;
	const withoutPrefix = instanceId.slice(4);
	const lastUnderscore = withoutPrefix.lastIndexOf("_");
	if (lastUnderscore === -1) return null;
	const beforeHash = withoutPrefix.slice(0, lastUnderscore);
	const secondLastUnderscore = beforeHash.lastIndexOf("_");
	if (secondLastUnderscore === -1) return null;
	const instanceNum = beforeHash.slice(secondLastUnderscore + 1);
	if (!/^\d+$/.test(instanceNum)) return null;
	return parseInt(instanceNum, 10);
}

/**
 * Checks if an ID is a seed ID.
 */
export function isSeedId(id: string): boolean {
	return id.startsWith("seed_");
}

/**
 * Checks if an ID is an instance ID (spawned from a seed).
 * Format: nft_[seedSuffix]_[N]_[20hex]
 */
export function isInstanceId(id: string): boolean {
	if (!id.startsWith("nft_")) return false;
	const withoutPrefix = id.slice(4);
	const lastUnderscore = withoutPrefix.lastIndexOf("_");
	if (lastUnderscore === -1) return false;
	const hash = withoutPrefix.slice(lastUnderscore + 1);
	if (!/^[a-f0-9]+$/.test(hash)) return false;
	const beforeHash = withoutPrefix.slice(0, lastUnderscore);
	const secondLastUnderscore = beforeHash.lastIndexOf("_");
	if (secondLastUnderscore === -1) return false;
	return /^\d+$/.test(beforeHash.slice(secondLastUnderscore + 1));
}

// ============ ART ID VALIDATION ============

export interface ArtIdValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Validates an artId according to protocol rules:
 * - Required field
 * - Max 14 characters
 * - Only letters, numbers, and hyphens
 * - No repeated hyphens (--)
 * - Cannot start or end with hyphen
 */
export function validateArtId(artId: string): ArtIdValidationResult {
	if (!artId) {
		return { valid: false, error: "artId is required" };
	}
	if (artId.length > 14) {
		return { valid: false, error: "maximum 14 characters" };
	}
	if (!/^[a-zA-Z0-9-]+$/.test(artId)) {
		return { valid: false, error: "only letters, numbers and hyphens allowed" };
	}
	if (/--/.test(artId)) {
		return { valid: false, error: "repeated hyphens not allowed" };
	}
	if (artId.startsWith("-") || artId.endsWith("-")) {
		return { valid: false, error: "cannot start or end with hyphen" };
	}
	return { valid: true };
}

/**
 * Validates an array of artIds and checks for duplicates.
 */
export function validateArtIdArray(artIds: string[]): {
	formatErrors: Array<{ index: number; artId: string; error: string }>;
	duplicates: string[];
	valid: boolean;
} {
	const formatErrors: Array<{ index: number; artId: string; error: string }> = [];
	const seen = new Map<string, number>();
	const duplicates: string[] = [];

	for (let i = 0; i < artIds.length; i++) {
		const artId = artIds[i]!;
		const validation = validateArtId(artId);

		if (!validation.valid) {
			formatErrors.push({ index: i, artId, error: validation.error! });
		}

		const normalized = artId.toLowerCase();
		if (seen.has(normalized)) {
			duplicates.push(artId);
		} else {
			seen.set(normalized, i);
		}
	}

	return {
		formatErrors,
		duplicates: [...new Set(duplicates)],
		valid: formatErrors.length === 0 && duplicates.length === 0,
	};
}

// ============ DETERMINISTIC ID GENERATION ============

/**
 * Generates a deterministic collection ID from creator + name + symbol.
 * Uses SHA-256 for cryptographic collision resistance.
 * Same inputs always produce the same collectionId.
 */
export async function generateDeterministicCollectionId(
	creator: string,
	name: string,
	symbol: string,
): Promise<string> {
	const input = `nftlox:col:${creator.toLowerCase()}:${name}:${symbol.toUpperCase()}`;
	const hash = await generateHash(input);
	return `col_${hash.slice(0, 14)}`;
}

/**
 * Generates a deterministic seed ID from collectionId + artId.
 * Uses SHA-256 for cryptographic collision resistance.
 * Format: seed_[20 hex] — 80 bits, birthday bound ~1.1T.
 * Same collectionId + artId always produce the same seedId.
 */
export async function generateDeterministicSeedId(
	collectionId: string,
	artId: string,
): Promise<string> {
	const input = `nftlox:seed:${collectionId}:${artId.toLowerCase()}`;
	const hash = await generateHash(input);
	return `seed_${hash.slice(0, 20)}`;
}

/**
 * Generates a deterministic instance ID from seedId + instanceNumber.
 * Uses SHA-256. Hash suffix is 20 hex chars (80 bits, birthday bound ~1.1T).
 * Same seedId + instanceNumber always produce the same instanceId.
 */
export async function generateDeterministicInstanceId(
	seedId: string,
	instanceNumber: number,
): Promise<string> {
	const input = `nftlox:inst:${seedId}:${instanceNumber}`;
	const hash = await generateHash(input);
	const seedSuffix = seedId.replace("seed_", "");
	return `nft_${seedSuffix}_${instanceNumber}_${hash.slice(0, INSTANCE_ID_HASH_LENGTH)}`;
}

// ============ PACK ID GENERATION ============

/**
 * Generates a deterministic pack ID from collectionId + packName.
 * Uses SHA-256 for cryptographic collision resistance.
 * Same inputs always produce the same packId.
 */
export async function generateDeterministicPackId(
	collectionId: string,
	packName: string,
): Promise<string> {
	const input = `nftlox:pack:${collectionId}:${packName.toLowerCase()}`;
	const hash = await generateHash(input);
	return `pack_${hash.slice(0, 14)}`;
}

// ============ LISTING ID GENERATION ============

/**
 * Generates a random nonce for listing ID generation.
 * Uses crypto.randomUUID() for universal runtime support.
 */
export function generateListingNonce(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, LISTING_NONCE_LENGTH);
}

/**
 * Generates a deterministic listing ID from listing parameters + nonce.
 * Formula: "list_" + sha256("nftlox:listing:v1:{nftId}:{owner}:{marketplace}:{amount}:{currency}:{expiresAt}:{nonce}").slice(0, 32)
 *
 * The nonce ensures uniqueness even for re-listings with identical parameters.
 * Any party can recompute this ID from the on-chain list payload.
 */
export async function generateListingId(params: {
	nftId: string;
	owner: string;
	marketplace: string;
	priceAmount: string;
	priceCurrency: string;
	expiresAt: number;
	nonce: string;
}): Promise<string> {
	const input = `nftlox:listing:v1:${params.nftId}:${params.owner}:${params.marketplace}:${params.priceAmount}:${params.priceCurrency}:${params.expiresAt}:${params.nonce}`;
	const hash = await generateHash(input);
	return LISTING_ID_PREFIX + hash.slice(0, LISTING_HASH_LENGTH);
}

/**
 * Checks if an ID is a pack ID.
 */
export function isPackId(id: string): boolean {
	return id.startsWith("pack_");
}

// ============ DETERMINISTIC INSTANCE DNA (for Pack Minting) ============

/**
 * Generates a deterministic instanceDna for NFTs minted from packs.
 * Uses SHA-256 over immutable block data to ensure all indexers produce identical results.
 * The txId acts as a cryptographic nonce (SHA-256 of the full serialized tx,
 * unique and unpredictable before mining).
 * Format: "i" + 19-char uppercase hex = 20 chars (INSTANCE_DNA_LENGTH).
 */
export async function generateDeterministicInstanceDna(
	seedId: string,
	instanceNumber: number,
	txId: string,
	blockNum: number,
): Promise<string> {
	const input = `nftlox:dna:${seedId}:${instanceNumber}:${txId}:${blockNum}`;
	const fullHash = await generateHash(input);
	return "i" + fullHash.slice(0, INSTANCE_DNA_LENGTH - 1).toUpperCase();
}

/**
 * Generates a deterministic access key for NFTs minted from packs.
 * Uses SHA-256 for cryptographic strength. Same inputs always produce
 * the same key across all indexers. The txId provides uniqueness per transaction.
 */
export async function generateDeterministicAccessKey(
	instanceDna: string,
	owner: string,
	txId: string,
): Promise<string> {
	const input = `nftlox:key:${instanceDna}:${owner}:${txId}`;
	const fullHash = await generateHash(input);
	return fullHash.slice(0, ACCESS_KEY_LENGTH).toUpperCase();
}

// ============ DETERMINISTIC RNG ============

/**
 * Deterministic RNG using SHA-256.
 * Returns a number in [0, 1) with 53-bit precision (JS safe integer range).
 * Same seed + index always produces the same result.
 *
 * Uses the first 7 bytes of SHA-256 to construct a 53-bit integer,
 * then divides by 2^53 for uniform distribution in [0, 1).
 * SHA-256 provides 256-bit avalanche — no practical collision ceiling.
 */
export function deterministicRng(seed: string, index: number): number {
	const input = `nftlox:rng:${seed}:${index}`;
	const hash = createHash("sha256").update(input).digest();
	const hi = hash.readUInt32BE(0) >>> 11; // top 21 bits
	const lo = hash.readUInt32BE(4);        // next 32 bits = 53 total
	return (hi * 0x100000000 + lo) / 0x20000000000000; // / 2^53
}

/**
 * Resolves a drop table using deterministic RNG.
 * Returns an array of seedIds selected based on weighted random.
 */
export function resolveDropTable(
	dropTable: Array<{ seedId: string; weight: number }>,
	itemCount: number,
	rngSeed: string,
): string[] {
	if (dropTable.length === 0) {
		throw new Error("resolveDropTable: dropTable cannot be empty");
	}

	const totalWeight = dropTable.reduce((sum, entry) => sum + entry.weight, 0);
	if (totalWeight <= 0) {
		throw new Error("resolveDropTable: totalWeight must be greater than 0");
	}

	const results: string[] = [];

	for (let i = 0; i < itemCount; i++) {
		const roll = deterministicRng(rngSeed, i) * totalWeight;
		let cumulative = 0;
		let selected = false;

		for (const entry of dropTable) {
			cumulative += entry.weight;
			if (roll < cumulative) {
				results.push(entry.seedId);
				selected = true;
				break;
			}
		}

		if (!selected) {
			results.push(dropTable[dropTable.length - 1]!.seedId);
		}
	}

	return results;
}
