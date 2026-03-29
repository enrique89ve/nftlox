// NFTLox DNA Generation Module
// Implements dual DNA system: originDna (collection) + instanceDna (individual NFT)

import {
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACCESS_KEY_LENGTH,
	LISTING_ID_PREFIX,
	LISTING_NONCE_LENGTH,
	LISTING_HASH_LENGTH,
} from "./constants";

// ============ HASH FUNCTIONS ============

/**
 * SHA-256 hash using Web Crypto (crypto.subtle).
 * Works in all modern runtimes: browsers, Node 18+, Deno, Bun, Cloudflare Workers.
 */
export async function generateHash(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @deprecated Use `generateHash` instead. Will be removed in a future version. */
export const generateHashAsync = generateHash;

// ============ ORIGIN DNA (Collection Level) ============

/**
 * Generates the origin DNA for a collection.
 * This DNA is shared by all NFTs in the collection (genetic thread).
 * DETERMINISTIC: Same collectionId always produces same originDna.
 */
export async function generateOriginDna(collectionId: string): Promise<string> {
	const input = `nftlox:origin:${collectionId}`;
	const fullHash = await generateHash(input);
	return fullHash.slice(0, ORIGIN_DNA_LENGTH).toUpperCase();
}

// ============ INSTANCE DNA (NFT Level) ============

/**
 * Generates the instance DNA for an individual NFT.
 * DETERMINISTIC: SHA-256 of nftId + originDna + edition + imageHash.
 * The nftId (seed_xxx or nft_xxx) guarantees uniqueness across NFTs.
 */
export async function generateInstanceDna(
	nftId: string,
	originDna: string,
	edition: number,
	imageHash: string,
): Promise<string> {
	const input = `nftlox:instance:${nftId}:${originDna}:${edition}:${imageHash}`;
	const fullHash = await generateHash(input);
	return fullHash.slice(0, INSTANCE_DNA_LENGTH).toUpperCase();
}

/**
 * Generates instance DNA for a replica.
 * DETERMINISTIC: SHA-256 derived from original's DNA to maintain lineage.
 */
export async function generateReplicaInstanceDna(
	originDna: string,
	originalInstanceDna: string,
): Promise<string> {
	const input = `nftlox:replica:${originDna}:${originalInstanceDna}`;
	const fullHash = await generateHash(input);
	return fullHash.slice(0, INSTANCE_DNA_LENGTH).toUpperCase();
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
 * Generates a replica ID from an original NFT ID.
 */
export function generateReplicaId(originalId: string): string {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `${originalId}_r${suffix}`;
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
 * Generates an instance ID from a seed.
 * Format: nft_[seedSuffix]_[instanceNumber]_[random]
 */
export function generateInstanceId(seedId: string, instanceNumber: number): string {
	const seedSuffix = seedId.replace("seed_", "");
	const randomSuffix = Math.random().toString(36).slice(2, 6);
	return `nft_${seedSuffix}_${instanceNumber}_${randomSuffix}`;
}

/**
 * Extracts the seed ID from an instance ID.
 * Returns null if the ID is not a valid instance format.
 */
export function extractSeedId(instanceId: string): string | null {
	const match = instanceId.match(/^nft_([a-z0-9]+)_\d+_[a-z0-9]+$/);
	return match ? `seed_${match[1]}` : null;
}

/**
 * Extracts the instance number from an instance ID.
 * Returns null if the ID is not a valid instance format.
 */
export function extractInstanceNumber(instanceId: string): number | null {
	const match = instanceId.match(/^nft_[a-z0-9]+_(\d+)_[a-z0-9]+$/);
	return match ? parseInt(match[1]!, 10) : null;
}

/**
 * Checks if an ID is a seed ID.
 */
export function isSeedId(id: string): boolean {
	return id.startsWith("seed_");
}

/**
 * Checks if an ID is an instance ID (spawned from a seed).
 */
export function isInstanceId(id: string): boolean {
	return /^nft_[a-z0-9]+_\d+_[a-z0-9]+$/.test(id);
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
 * Deterministic hash function (no random, no timestamp).
 * Uses FNV-1a algorithm for better distribution and collision resistance.
 */
export function deterministicHash(input: string): string {
	// FNV-1a 32-bit hash
	let hash1 = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash1 ^= input.charCodeAt(i);
		hash1 = Math.imul(hash1, 16777619);
	}

	// Second pass with different seed for more bits
	let hash2 = 2166136261;
	for (let i = input.length - 1; i >= 0; i--) {
		hash2 ^= input.charCodeAt(i);
		hash2 = Math.imul(hash2, 16777619);
	}

	// Combine both hashes for better uniqueness
	const combined = (Math.abs(hash1) >>> 0).toString(36) + (Math.abs(hash2) >>> 0).toString(36);
	return combined.padStart(12, "0").slice(0, 12);
}

/**
 * Generates a deterministic collection ID from creator + name + symbol.
 * Same inputs always produce the same collectionId.
 */
export function generateDeterministicCollectionId(
	creator: string,
	name: string,
	symbol: string,
): string {
	const input = `nftlox:col:${creator.toLowerCase()}:${name}:${symbol.toUpperCase()}`;
	const hash = deterministicHash(input);
	return `col_${hash.slice(0, 12)}`;
}

/**
 * Generates a deterministic seed ID from collectionId + artId.
 * Same collectionId + artId always produce the same seedId.
 */
export function generateDeterministicSeedId(
	collectionId: string,
	artId: string,
): string {
	const input = `nftlox:seed:${collectionId}:${artId.toLowerCase()}`;
	const hash = deterministicHash(input);
	return `seed_${hash.slice(0, 8)}`;
}

/**
 * Generates a deterministic instance ID from seedId + instanceNumber.
 * Same seedId + instanceNumber always produce the same instanceId.
 */
export function generateDeterministicInstanceId(
	seedId: string,
	instanceNumber: number,
): string {
	const input = `nftlox:inst:${seedId}:${instanceNumber}`;
	const hash = deterministicHash(input);
	const seedSuffix = seedId.replace("seed_", "");
	return `nft_${seedSuffix}_${instanceNumber}_${hash.slice(0, 4)}`;
}

// ============ PACK ID GENERATION ============

/**
 * Generates a deterministic pack ID from collectionId + packName.
 * Same inputs always produce the same packId.
 */
export function generateDeterministicPackId(
	collectionId: string,
	packName: string,
): string {
	const input = `nftlox:pack:${collectionId}:${packName.toLowerCase()}`;
	const hash = deterministicHash(input);
	return `pack_${hash.slice(0, 12)}`;
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
 * Uses immutable block data to ensure all indexers produce identical results.
 * Format: 14-char uppercase hex, matching INSTANCE_DNA_LENGTH.
 */
export function generateDeterministicInstanceDna(
	seedId: string,
	instanceNumber: number,
	txId: string,
	blockNum: number,
): string {
	const input = `nftlox:dna:${seedId}:${instanceNumber}:${txId}:${blockNum}`;
	const hash = deterministicHash(input);
	return hash.padStart(INSTANCE_DNA_LENGTH, "0").slice(0, INSTANCE_DNA_LENGTH).toUpperCase();
}

/**
 * Generates a deterministic access key for NFTs minted from packs.
 * Same inputs always produce the same key across all indexers.
 */
export function generateDeterministicAccessKey(
	instanceDna: string,
	owner: string,
	txId: string,
): string {
	const input = `nftlox:key:${instanceDna}:${owner}:${txId}`;
	const hash = deterministicHash(input);
	return hash.slice(0, ACCESS_KEY_LENGTH).toUpperCase();
}

// ============ DETERMINISTIC RNG ============

/**
 * Deterministic RNG using double-pass FNV-1a.
 * Returns a number in [0, 1) normalized by dividing by 2^32.
 * Same seed + index always produces the same result.
 */
export function deterministicRng(seed: string, index: number): number {
	const input = `nftlox:rng:${seed}:${index}`;

	// FNV-1a 32-bit hash (same pattern as deterministicHash)
	let hash1 = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash1 ^= input.charCodeAt(i);
		hash1 = Math.imul(hash1, 16777619);
	}

	let hash2 = 2166136261;
	for (let i = input.length - 1; i >= 0; i--) {
		hash2 ^= input.charCodeAt(i);
		hash2 = Math.imul(hash2, 16777619);
	}

	// Combine and normalize to [0, 1)
	const combined = (Math.abs(hash1) ^ Math.abs(hash2)) >>> 0;
	return combined / 4294967296; // 2^32
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
