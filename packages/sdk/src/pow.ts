// NFTLox multisig Proof of Work helpers.
// The token is sent as an HTTP header; it never mutates the Hive payload.

export const NFTLOX_POW_HEADER = "X-NFTLox-PoW";
export const MULTISIG_POW_VERSION = "v1";
export const DEFAULT_MULTISIG_POW_BITS = 10;
export const MAX_MULTISIG_POW_BITS = 24;

const POW_DOMAIN = "nftlox:multisig:pow";
const RANDOM_BYTES = 16;
const HEX_REGEX = /^[a-f0-9]+$/;

type JsonObjectLike = Readonly<Record<string, unknown>>;

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

function randomHex(bytes = RANDOM_BYTES): string {
	const randomBytes = crypto.getRandomValues(new Uint8Array(bytes));
	return bytesToHex(randomBytes);
}

function assertPowBits(bits: number): number {
	if (!Number.isInteger(bits) || bits < 0 || bits > MAX_MULTISIG_POW_BITS) {
		throw new RangeError(`PoW bits must be an integer between 0 and ${MAX_MULTISIG_POW_BITS}`);
	}
	return bits;
}

async function sha256Hex(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const buffer = await crypto.subtle.digest("SHA-256", encoded);
	return bytesToHex(new Uint8Array(buffer));
}

export function canonicalPowJson(payload: unknown): string {
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

export async function solveMultisigPow(
	payload: unknown,
	requestedBits = DEFAULT_MULTISIG_POW_BITS,
): Promise<string> {
	const bits = assertPowBits(requestedBits);
	const timestampMs = Date.now();
	const payloadHash = await hashJsonPayload(payload);
	const rand = randomHex();

	for (let nonce = 0; nonce <= Number.MAX_SAFE_INTEGER; nonce++) {
		const token = `${MULTISIG_POW_VERSION}:${bits}:${timestampMs}:${payloadHash}:${rand}:${nonce}`;
		const workHash = await hashMultisigPowToken(token);
		if (hasLeadingZeroBits(workHash, bits)) {
			return token;
		}
	}

	throw new Error("Unable to solve multisig PoW before reaching the nonce limit");
}
