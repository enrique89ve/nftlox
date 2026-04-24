// NFTLox Protocol — DNA & ID generation.
// Pure functions using Web Crypto (crypto.subtle) — works in Bun/Node 18+/browsers/Deno.

import {
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACCESS_KEY_LENGTH,
	INSTANCE_ID_HASH_LENGTH,
	COLLECTION_ID_HASH_LENGTH,
	IMAGE_ID_HASH_LENGTH,
	COLLECTION_ID_PREFIX,
	SEED_ID_PREFIX,
	INSTANCE_ID_PREFIX,
	IMAGE_ID_PREFIX,
	ORIGIN_DNA_PREFIX,
	NFT_DNA_PREFIX,
	LISTING_ID_PREFIX,
	LISTING_NONCE_LENGTH,
	LISTING_HASH_LENGTH,
	HASH_DOMAIN_COL,
	HASH_DOMAIN_ORIGIN,
	HASH_DOMAIN_SEED,
	HASH_DOMAIN_DNA,
	HASH_DOMAIN_KEY,
	HASH_DOMAIN_SEED_DNA,
	HASH_DOMAIN_IMG,
	HASH_DOMAIN_LISTING,
} from "./constants";

// Hash

/** SHA-256 hex hash via Web Crypto. Universal runtime support. */
export async function generateHash(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Origin DNA (collection-level)

export async function generateOriginDna(collectionId: string): Promise<string> {
	const input = `${HASH_DOMAIN_ORIGIN}${collectionId}`;
	const fullHash = await generateHash(input);
	return ORIGIN_DNA_PREFIX + fullHash.slice(0, ORIGIN_DNA_LENGTH - ORIGIN_DNA_PREFIX.length).toUpperCase();
}

// Seed DNA — hashed from (seedId, originDna, edition, imageHash). The only
// caller is `handleMint` / the SDK's `buildSeed` to produce a seed NFT's
// identity. Stored in the `nfts.nft_dna` column (one DNA per row, seed or
// instance). Uses HASH_DOMAIN_SEED_DNA; instance DNA uses the distinct
// HASH_DOMAIN_DNA salt below to prevent cross-kind collisions by construction.
export async function generateSeedDna(
	nftId: string,
	originDna: string,
	edition: number,
	imageHash: string,
): Promise<string> {
	const input = `${HASH_DOMAIN_SEED_DNA}${nftId}:${originDna}:${edition}:${imageHash}`;
	const fullHash = await generateHash(input);
	return NFT_DNA_PREFIX + fullHash.slice(0, INSTANCE_DNA_LENGTH - NFT_DNA_PREFIX.length).toUpperCase();
}

// Image Hash

export async function generateImageHash(imageUrl: string): Promise<string> {
	const input = `${HASH_DOMAIN_IMG}${imageUrl}`;
	const fullHash = await generateHash(input);
	return `${IMAGE_ID_PREFIX}${fullHash.slice(0, IMAGE_ID_HASH_LENGTH)}`;
}

// Deterministic IDs

export async function generateDeterministicCollectionId(
	creator: string,
	name: string,
	symbol: string,
): Promise<string> {
	const input = `${HASH_DOMAIN_COL}${creator.toLowerCase()}:${name}:${symbol.toUpperCase()}`;
	const hash = await generateHash(input);
	return `${COLLECTION_ID_PREFIX}${hash.slice(0, COLLECTION_ID_HASH_LENGTH)}`;
}

export async function generateDeterministicSeedId(
	collectionId: string,
	artId: string,
): Promise<string> {
	const input = `${HASH_DOMAIN_SEED}${collectionId}:${artId.toLowerCase()}`;
	const hash = await generateHash(input);
	// Seed and instance ids share the same hash length so their on-chain
	// footprints match and the INSTANCE_ID_REGEX machinery below stays stable.
	return `${SEED_ID_PREFIX}${hash.slice(0, INSTANCE_ID_HASH_LENGTH)}`;
}

export async function generateDeterministicInstanceId(
	seedId: string,
	instanceNumber: number,
): Promise<string> {
	const seedSuffix = seedId.slice(SEED_ID_PREFIX.length);
	return `${INSTANCE_ID_PREFIX}${seedSuffix}_${instanceNumber}`;
}

/** Thin wrapper for backwards-compatible import name. */
export async function generateInstanceId(
	seedId: string,
	instanceNumber: number,
): Promise<string> {
	return await generateDeterministicInstanceId(seedId, instanceNumber);
}

// ID guards & extraction

// Regex built from INSTANCE_ID_HASH_LENGTH + INSTANCE_ID_PREFIX so both the
// prefix and hash-length constants are the single source of truth. A mismatch
// between this regex and the id emitted by generateDeterministicInstanceId
// would silently break extractSeedId/extractInstanceNumber at runtime.
const INSTANCE_ID_REGEX = new RegExp(
	`^${INSTANCE_ID_PREFIX}[a-f0-9]{${INSTANCE_ID_HASH_LENGTH}}_\\d+$`,
);
const INSTANCE_ID_SEED_CAPTURE_REGEX = new RegExp(
	`^${INSTANCE_ID_PREFIX}([a-f0-9]{${INSTANCE_ID_HASH_LENGTH}})_\\d+$`,
);
const INSTANCE_ID_NUMBER_CAPTURE_REGEX = new RegExp(
	`^${INSTANCE_ID_PREFIX}[a-f0-9]{${INSTANCE_ID_HASH_LENGTH}}_(\\d+)$`,
);

export function isSeedId(id: string): boolean {
	return id.startsWith(SEED_ID_PREFIX);
}

export function isInstanceId(id: string): boolean {
	return INSTANCE_ID_REGEX.test(id);
}

export function extractSeedId(instanceId: string): string | null {
	const match = instanceId.match(INSTANCE_ID_SEED_CAPTURE_REGEX);
	if (!match || !match[1]) return null;
	return `${SEED_ID_PREFIX}${match[1]}`;
}

export function extractInstanceNumber(instanceId: string): number | null {
	const match = instanceId.match(INSTANCE_ID_NUMBER_CAPTURE_REGEX);
	if (!match || !match[1]) return null;
	return parseInt(match[1], 10);
}

// Instance DNA — hashed from (seedId, instanceNumber, txId, blockNum).
// Called by `handleBulkDistribute` / the SDK's verifiers to derive an
// instance's DNA deterministically from its parent seed plus the op
// context. Preimage uses HASH_DOMAIN_DNA; seed DNA uses HASH_DOMAIN_SEED_DNA.
export async function generateInstanceDna(
	seedId: string,
	instanceNumber: number,
	txId: string,
	blockNum: number,
): Promise<string> {
	const input = `${HASH_DOMAIN_DNA}${seedId}:${instanceNumber}:${txId}:${blockNum}`;
	const fullHash = await generateHash(input);
	return NFT_DNA_PREFIX + fullHash.slice(0, INSTANCE_DNA_LENGTH - NFT_DNA_PREFIX.length).toUpperCase();
}

export async function generateDeterministicAccessKey(
	nftDna: string,
	owner: string,
	txId: string,
): Promise<string> {
	const input = `${HASH_DOMAIN_KEY}${nftDna}:${owner}:${txId}`;
	const fullHash = await generateHash(input);
	return fullHash.slice(0, ACCESS_KEY_LENGTH).toUpperCase();
}

// Listings

export function generateListingNonce(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, LISTING_NONCE_LENGTH);
}

export async function generateListingId(params: {
	readonly nftId: string;
	readonly owner: string;
	readonly marketplace: string;
	readonly priceAmount: string;
	readonly priceCurrency: string;
	readonly expiresAt: number;
	readonly nonce: string;
}): Promise<string> {
	const input = `${HASH_DOMAIN_LISTING}${params.nftId}:${params.owner}:${params.marketplace}:${params.priceAmount}:${params.priceCurrency}:${params.expiresAt}:${params.nonce}`;
	const hash = await generateHash(input);
	return LISTING_ID_PREFIX + hash.slice(0, LISTING_HASH_LENGTH);
}
