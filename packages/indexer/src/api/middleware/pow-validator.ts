// Multisig Proof of Work validator.
// The cache is process-local by design, matching the existing in-memory rate limiters.

import type { MultisigErrorCode } from "@/protocol/index.ts";

export const NFTLOX_POW_HEADER = "X-NFTLox-PoW";
export const MULTISIG_POW_VERSION = "v1";
export const MAX_MULTISIG_POW_BITS = 24;

const POW_DOMAIN = "nftlox:multisig:pow";
const MAX_TOKEN_LENGTH = 256;
const HEX_64_REGEX = /^[a-f0-9]{64}$/;
const HEX_REGEX = /^[a-f0-9]+$/;
const DECIMAL_REGEX = /^\d+$/;

const replayCache = new Map<string, number>();

type JsonObjectLike = Readonly<Record<string, unknown>>;

export type PowValidationResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: MultisigErrorCode; message: string }>;

export type ValidateMultisigPowParams = Readonly<{
	body: unknown;
	header: string | null;
	requiredBits: number;
	ttlMs: number;
	maxFutureSkewMs: number;
	replayCacheMax: number;
	nowMs?: number;
}>;

type ParsedPowToken = Readonly<{
	token: string;
	bits: number;
	timestampMs: number;
	payloadHash: string;
}>;

function isJsonObjectLike(value: unknown): value is JsonObjectLike {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeysDeep(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (isJsonObjectLike(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			sorted[key] = sortKeysDeep(value[key]);
		}
		return sorted;
	}
	return value;
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

async function sha256Hex(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const buffer = await crypto.subtle.digest("SHA-256", encoded);
	return bytesToHex(new Uint8Array(buffer));
}

function canonicalPowJson(payload: unknown): string {
	const json = JSON.stringify(sortKeysDeep(payload));
	if (json === undefined) {
		throw new TypeError("PoW payload must be JSON serializable");
	}
	return json;
}

export async function hashJsonPayload(payload: unknown): Promise<string> {
	return sha256Hex(canonicalPowJson(payload));
}

export async function hashMultisigPowToken(token: string): Promise<string> {
	return sha256Hex(`${POW_DOMAIN}:${token}`);
}

export function hasLeadingZeroBits(hex: string, bits: number): boolean {
	if (!Number.isInteger(bits) || bits < 0 || bits > hex.length * 4 || !HEX_REGEX.test(hex)) {
		return false;
	}

	const fullZeroNibbles = Math.floor(bits / 4);
	for (let i = 0; i < fullZeroNibbles; i++) {
		if (hex[i] !== "0") return false;
	}

	const remainingBits = bits % 4;
	if (remainingBits === 0) return true;

	const nibble = Number.parseInt(hex[fullZeroNibbles] ?? "", 16);
	if (Number.isNaN(nibble)) return false;
	return (nibble >> (4 - remainingBits)) === 0;
}

function parsePowToken(header: string): ParsedPowToken | null {
	if (header.length === 0 || header.length > MAX_TOKEN_LENGTH) return null;

	const parts = header.split(":");
	if (parts.length !== 6) return null;

	const [version, bitsRaw, timestampRaw, payloadHash, rand, nonceRaw] = parts;
	if (
		version !== MULTISIG_POW_VERSION ||
		!bitsRaw ||
		!timestampRaw ||
		!payloadHash ||
		!rand ||
		!nonceRaw ||
		!DECIMAL_REGEX.test(bitsRaw) ||
		!DECIMAL_REGEX.test(timestampRaw) ||
		!HEX_64_REGEX.test(payloadHash) ||
		!HEX_REGEX.test(rand) ||
		!DECIMAL_REGEX.test(nonceRaw)
	) {
		return null;
	}

	const bits = Number(bitsRaw);
	const timestampMs = Number(timestampRaw);
	if (
		!Number.isSafeInteger(bits) ||
		!Number.isSafeInteger(timestampMs) ||
		bits < 0 ||
		bits > MAX_MULTISIG_POW_BITS
	) {
		return null;
	}

	return { token: header, bits, timestampMs, payloadHash };
}

function cleanupReplayCache(nowMs: number): void {
	for (const [token, expiresAt] of replayCache) {
		if (expiresAt <= nowMs) {
			replayCache.delete(token);
		}
	}
}

function rememberToken(token: string, nowMs: number, ttlMs: number, replayCacheMax: number): void {
	if (replayCacheMax <= 0) return;

	replayCache.set(token, nowMs + ttlMs);
	while (replayCache.size > replayCacheMax) {
		const oldestToken = replayCache.keys().next().value;
		if (typeof oldestToken !== "string") return;
		replayCache.delete(oldestToken);
	}
}

export function clearMultisigPowReplayCache(): void {
	replayCache.clear();
}

export async function validateMultisigPow(
	params: ValidateMultisigPowParams,
): Promise<PowValidationResult> {
	const nowMs = params.nowMs ?? Date.now();
	cleanupReplayCache(nowMs);

	const rawHeader = params.header?.trim();
	if (!rawHeader) {
		return { ok: false, code: "POW_REQUIRED", message: "Proof of Work required" };
	}

	const parsed = parsePowToken(rawHeader);
	if (!parsed) {
		return { ok: false, code: "INVALID_POW", message: "Invalid Proof of Work token" };
	}

	if (parsed.bits < params.requiredBits) {
		return { ok: false, code: "INVALID_POW", message: "Proof of Work difficulty is too low" };
	}

	if (parsed.timestampMs > nowMs + params.maxFutureSkewMs || nowMs - parsed.timestampMs > params.ttlMs) {
		return { ok: false, code: "POW_EXPIRED", message: "Proof of Work token expired" };
	}

	if (replayCache.has(parsed.token)) {
		return { ok: false, code: "POW_REPLAYED", message: "Proof of Work token was already used" };
	}

	const expectedPayloadHash = await hashJsonPayload(params.body);
	if (parsed.payloadHash !== expectedPayloadHash) {
		return { ok: false, code: "INVALID_POW", message: "Proof of Work payload hash mismatch" };
	}

	const workHash = await hashMultisigPowToken(parsed.token);
	if (!hasLeadingZeroBits(workHash, parsed.bits)) {
		return { ok: false, code: "INVALID_POW", message: "Proof of Work difficulty check failed" };
	}

	rememberToken(parsed.token, nowMs, params.ttlMs, params.replayCacheMax);
	return { ok: true };
}
