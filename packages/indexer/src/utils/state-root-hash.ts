// State-root hash — incremental rolling XOR of per-NFT row hashes.
//
// Why this shape:
//   root = SHA256(row_1) XOR SHA256(row_2) XOR ... XOR SHA256(row_N)
//
// - O(1) per mutation: an ownership change only needs to XOR out the old row
//   hash and XOR in the new one. Scales identically at 1k NFTs or 100M NFTs.
// - Order-independent: XOR is commutative and associative, so two indexers
//   processing the same multiset of operations in different orders converge
//   to the same root. This is critical for multi-node parity without a
//   shared serialization protocol.
// - Publicly auditable in O(1): verification is a single byte comparison.
//
// What this does NOT give us:
// - Collision resistance against an adversary choosing inputs. The XOR of
//   256-bit hashes has a birthday bound around 2^128 — strong enough to
//   detect divergence between honest nodes, but the real SPV guarantee
//   comes from HafAH, not from this root. The root is a comparison tool,
//   not a proof of correctness.

import { HASH_FORMAT_PREFIX, canonicalJson } from "@/protocol/index.ts";

// ============ ROW SHAPE ============

// Only the SPV-visible ownership fields contribute to the root. Any mutation
// that doesn't change these fields (e.g. listing updates, data refs) is a
// no-op for state-root purposes — by construction the row hash is unchanged.
export type NftStateRow = Readonly<{
	id: string;
	owner: string;
	previous_owner: string | null;
	owner_action: string;
	owner_operation_id: string;
	owner_block_num: number;
}>;

export type StateRootDelta =
	| Readonly<{ type: "insert"; newRow: NftStateRow }>
	| Readonly<{ type: "update"; oldRow: NftStateRow; newRow: NftStateRow }>
	| Readonly<{ type: "delete"; oldRow: NftStateRow }>;

// ============ PRIMITIVES ============

export const STATE_ROOT_BYTES = 32; // SHA-256 output

// Returns a fresh zero buffer on every call. Do not cache — callers xor into
// the returned buffer and mutating a shared zero would corrupt future callers.
export function emptyStateRoot(): Uint8Array {
	return new Uint8Array(STATE_ROOT_BYTES);
}

function assertRootLength(buffer: Uint8Array, label: string): void {
	if (buffer.length !== STATE_ROOT_BYTES) {
		throw new Error(
			`${label}: expected ${STATE_ROOT_BYTES} bytes, got ${buffer.length}`,
		);
	}
}

export function xorInto(target: Uint8Array, operand: Uint8Array): Uint8Array {
	assertRootLength(target, "xorInto target");
	assertRootLength(operand, "xorInto operand");
	const result = new Uint8Array(STATE_ROOT_BYTES);
	for (let i = 0; i < STATE_ROOT_BYTES; i++) {
		// biome-ignore lint: bang safe — length-checked above
		result[i] = target[i]! ^ operand[i]!;
	}
	return result;
}

// The row is handed directly to canonicalJson. Do NOT reconstruct a literal
// here and enumerate keys by hand — that would create a silent footgun where
// adding a field to NftStateRow compiles fine but silently drops the field
// from the hash, fracturing convergence between indexers running old vs new
// code. The type alone is the consensus surface.
export async function hashRow(row: NftStateRow): Promise<Uint8Array> {
	const canonical = canonicalJson(row as unknown as Record<string, unknown>);
	const encoded = new TextEncoder().encode(canonical);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return new Uint8Array(digest);
}

// ============ DELTA APPLICATION ============

export async function applyDelta(
	root: Uint8Array,
	delta: StateRootDelta,
): Promise<Uint8Array> {
	switch (delta.type) {
		case "insert": {
			const newHash = await hashRow(delta.newRow);
			return xorInto(root, newHash);
		}
		case "delete": {
			const oldHash = await hashRow(delta.oldRow);
			return xorInto(root, oldHash);
		}
		case "update": {
			const oldHash = await hashRow(delta.oldRow);
			const newHash = await hashRow(delta.newRow);
			return xorInto(xorInto(root, oldHash), newHash);
		}
	}
}

// ============ REFERENCE FULL-SCAN ============

// Reference implementation — O(N) in NFT count. Used ONLY for bootstrap (one
// time, at startup with pre-existing data) and for the audit job that verifies
// the incremental root hasn't drifted. Never call on the hot path.
export async function computeStateRootFullScan(
	rows: Iterable<NftStateRow>,
): Promise<Uint8Array> {
	let root = emptyStateRoot();
	for (const row of rows) {
		const rowHash = await hashRow(row);
		root = xorInto(root, rowHash);
	}
	return root;
}

// ============ ENCODING ============

export function formatStateRoot(root: Uint8Array): string {
	assertRootLength(root, "formatStateRoot");
	let hex = "";
	for (const byte of root) hex += byte.toString(16).padStart(2, "0");
	return `${HASH_FORMAT_PREFIX}${hex}`;
}

export function parseStateRoot(value: string): Uint8Array {
	if (!value.startsWith(HASH_FORMAT_PREFIX)) {
		throw new Error(`parseStateRoot: expected "${HASH_FORMAT_PREFIX}..." prefix`);
	}
	const hex = value.slice(HASH_FORMAT_PREFIX.length);
	if (hex.length !== STATE_ROOT_BYTES * 2 || !/^[0-9a-f]+$/.test(hex)) {
		throw new Error(`parseStateRoot: invalid hex payload`);
	}
	const buffer = new Uint8Array(STATE_ROOT_BYTES);
	for (let i = 0; i < STATE_ROOT_BYTES; i++) {
		buffer[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return buffer;
}

// Branchless for predictability, not for timing-attack resistance. The root
// is a public value comparable byte-for-byte; there is no adversary at this
// layer whose access depends on short-circuit timing.
export function rootsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		// biome-ignore lint: bang safe — lengths equal
		diff |= a[i]! ^ b[i]!;
	}
	return diff === 0;
}
