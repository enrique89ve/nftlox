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
	SYMBOL_REGEX,
	TX_ID_REGEX,
	HASH_DOMAIN_COL,
	HASH_DOMAIN_ORIGIN,
	HASH_DOMAIN_SEED,
	HASH_DOMAIN_DNA,
	HASH_DOMAIN_KEY,
	HASH_DOMAIN_SEED_DNA,
	HASH_DOMAIN_IMG,
	HASH_DOMAIN_LISTING,
} from "./constants";
import { toWireUrl } from "./url";

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
//
// Third-party consumers can pass any shape of URL (full https, full http, or
// already-stripped wire form). `toWireUrl` canonicalises to the on-chain wire
// form before hashing, so the SDK builder and the indexer always derive the
// same image id for the same logical image — regardless of who holds the
// scheme prefix at call time.

export async function generateImageHash(imageUrl: string): Promise<string> {
	const canonical = toWireUrl(imageUrl);
	const input = `${HASH_DOMAIN_IMG}${canonical}`;
	const fullHash = await generateHash(input);
	return `${IMAGE_ID_PREFIX}${fullHash.slice(0, IMAGE_ID_HASH_LENGTH)}`;
}

// Deterministic IDs

export async function generateDeterministicCollectionId(
	creator: string,
	name: string,
	symbol: string,
): Promise<string> {
	// NFC-normalize free-form string inputs so visually-identical names typed
	// on different platforms (Android NFD, Desktop NFC, macOS HFS+ NFD) map to
	// the same canonical id. creator and symbol are ASCII-gated upstream via
	// validateHiveUsername / SYMBOL_REGEX and are exempt.
	const input = `${HASH_DOMAIN_COL}${creator.toLowerCase()}:${name.normalize("NFC")}:${symbol.toUpperCase()}`;
	const hash = await generateHash(input);
	return `${COLLECTION_ID_PREFIX}${hash.slice(0, COLLECTION_ID_HASH_LENGTH)}`;
}

export async function generateDeterministicSeedId(
	collectionId: string,
	artId: string,
): Promise<string> {
	const input = `${HASH_DOMAIN_SEED}${collectionId}:${artId.normalize("NFC").toLowerCase()}`;
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

// Single parse regex — built from INSTANCE_ID_HASH_LENGTH + INSTANCE_ID_PREFIX
// so the prefix and hash-length constants stay the single source of truth.
// A mismatch between this regex and the id emitted by
// generateDeterministicInstanceId would silently break parseInstanceId and
// every helper below that consumes it.
const INSTANCE_ID_PARSE_REGEX = new RegExp(
	`^${INSTANCE_ID_PREFIX}([a-f0-9]{${INSTANCE_ID_HASH_LENGTH}})_(\\d+)$`,
);

export function isSeedId(id: string): boolean {
	return id.startsWith(SEED_ID_PREFIX);
}

export function isInstanceId(id: string): boolean {
	return INSTANCE_ID_PARSE_REGEX.test(id);
}

// Listing-id shape guard — derived from LISTING_ID_PREFIX + LISTING_HASH_LENGTH
// so the regex and the emitter (`generateListingId` below) stay locked to a
// single source of truth. Pure shape check; no DB or hash lookup.
const LISTING_ID_PARSE_REGEX = new RegExp(
	`^${LISTING_ID_PREFIX}[a-f0-9]{${LISTING_HASH_LENGTH}}$`,
);

export function isListingId(id: string): boolean {
	return LISTING_ID_PARSE_REGEX.test(id);
}

// Hive transaction id — 40 lowercase hex chars (RIPEMD-160 of the serialized
// tx body). Reused from constants.ts so a hardfork on the digest format flips
// one source. Wrapped as a function so call sites read symmetrically with the
// other id guards.
export function isHiveTxId(id: string): boolean {
	return TX_ID_REGEX.test(id);
}

// Collection symbol shape — derived from SYMBOL_REGEX (3-10 uppercase chars,
// leading letter, A-Z0-9). Wrapped as a function so multisig + handler call
// sites read symmetrically with isInstanceId/isListingId/isHiveTxId and the
// underlying regex stays the single source of truth.
export function isSymbol(value: string): boolean {
	return SYMBOL_REGEX.test(value);
}

// Collection-id shape — COLLECTION_ID_PREFIX followed by COLLECTION_ID_HASH_LENGTH
// lowercase hex chars. Derived from the emitter in
// `generateDeterministicCollectionId` so the regex and the producer share the
// same constants; a hardfork on either flips one source.
const COLLECTION_ID_PARSE_REGEX = new RegExp(
	`^${COLLECTION_ID_PREFIX}[a-f0-9]{${COLLECTION_ID_HASH_LENGTH}}$`,
);

export function isCollectionId(id: string): boolean {
	return COLLECTION_ID_PARSE_REGEX.test(id);
}

/**
 * Parses a full instance id into its seed id and instance number. Returns
 * `null` when the input does not match the canonical instance-id form
 * (INSTANCE_ID_PREFIX + hex hash + underscore + number).
 * Primary helper: `extractSeedId` and `extractInstanceNumber` are thin
 * wrappers retained for backwards compatibility with the SDK public surface.
 */
export function parseInstanceId(
	id: string,
): { readonly seedId: string; readonly instanceNumber: number } | null {
	const match = INSTANCE_ID_PARSE_REGEX.exec(id);
	if (!match || !match[1] || !match[2]) return null;
	return {
		seedId: `${SEED_ID_PREFIX}${match[1]}`,
		instanceNumber: Number.parseInt(match[2], 10),
	};
}

export function extractSeedId(instanceId: string): string | null {
	return parseInstanceId(instanceId)?.seedId ?? null;
}

export function extractInstanceNumber(instanceId: string): number | null {
	return parseInstanceId(instanceId)?.instanceNumber ?? null;
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
