// NFTLox Protocol — DNA & ID generation.
// Pure functions using Web Crypto (crypto.subtle) — works in Bun/Node 18+/browsers/Deno.

import {
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACCESS_KEY_LENGTH,
	INSTANCE_ID_HASH_LENGTH,
	LISTING_ID_PREFIX,
	LISTING_NONCE_LENGTH,
	LISTING_HASH_LENGTH,
} from "./constants.ts";

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
	const input = `nftlox:origin:${collectionId}`;
	const fullHash = await generateHash(input);
	return "o" + fullHash.slice(0, ORIGIN_DNA_LENGTH - 1).toUpperCase();
}

// Instance DNA (NFT-level, deterministic from metadata)

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

// Image Hash

export async function generateImageHash(imageUrl: string): Promise<string> {
	const input = `nftlox:img:${imageUrl}`;
	const fullHash = await generateHash(input);
	return `img_${fullHash.slice(0, 16)}`;
}

// Deterministic IDs

export async function generateDeterministicCollectionId(
	creator: string,
	name: string,
	symbol: string,
): Promise<string> {
	const input = `nftlox:col:${creator.toLowerCase()}:${name}:${symbol.toUpperCase()}`;
	const hash = await generateHash(input);
	return `col_${hash.slice(0, 14)}`;
}

export async function generateDeterministicSeedId(
	collectionId: string,
	artId: string,
): Promise<string> {
	const input = `nftlox:seed:${collectionId}:${artId.toLowerCase()}`;
	const hash = await generateHash(input);
	return `seed_${hash.slice(0, 20)}`;
}

export async function generateDeterministicInstanceId(
	seedId: string,
	instanceNumber: number,
): Promise<string> {
	const input = `nftlox:inst:${seedId}:${instanceNumber}`;
	const hash = await generateHash(input);
	const seedSuffix = seedId.replace("seed_", "");
	return `nft_${seedSuffix}_${instanceNumber}_${hash.slice(0, INSTANCE_ID_HASH_LENGTH)}`;
}

/** Thin wrapper for backwards-compatible import name. */
export async function generateInstanceId(
	seedId: string,
	instanceNumber: number,
): Promise<string> {
	return await generateDeterministicInstanceId(seedId, instanceNumber);
}

// ID guards & extraction

export function isSeedId(id: string): boolean {
	return id.startsWith("seed_");
}

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

// Bulk-distribute deterministic DNA + access keys

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

export async function generateDeterministicAccessKey(
	instanceDna: string,
	owner: string,
	txId: string,
): Promise<string> {
	const input = `nftlox:key:${instanceDna}:${owner}:${txId}`;
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
	const input = `nftlox:listing:v1:${params.nftId}:${params.owner}:${params.marketplace}:${params.priceAmount}:${params.priceCurrency}:${params.expiresAt}:${params.nonce}`;
	const hash = await generateHash(input);
	return LISTING_ID_PREFIX + hash.slice(0, LISTING_HASH_LENGTH);
}
