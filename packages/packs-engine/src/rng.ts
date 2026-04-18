import { createHash } from "crypto";

// Runtime: Node.js ≥18 and Bun. This module is NOT browser-safe because
// `deterministicRng` uses Node's `crypto.createHash` for synchronous hashing
// inside the drop-table selection loop. Pack opening is always server-side —
// it needs blockchain-anchored context (txId, blockNum) that only a backend
// with indexer access can provide — so this is a deliberate constraint.

/**
 * Async SHA-256 via Web Crypto. Used only by `generateDeterministicPackId`.
 */
async function generateHash(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

/**
 * Checks if an ID is a pack ID.
 */
export function isPackId(id: string): boolean {
	return id.startsWith("pack_");
}

/**
 * Deterministic RNG using SHA-256. Returns a number in [0, 1) with 53-bit
 * precision. Same seed + index always produces the same result.
 *
 * Uses the first 7 bytes of SHA-256 to construct a 53-bit integer, then
 * divides by 2^53 for uniform distribution in [0, 1). Sync (Node
 * `crypto.createHash`) because `resolveDropTable()` calls it in a tight loop.
 */
export function deterministicRng(seed: string, index: number): number {
	const input = `nftlox:rng:${seed}:${index}`;
	const hash = createHash("sha256").update(input).digest();
	const hi = hash.readUInt32BE(0) >>> 11; // top 21 bits
	const lo = hash.readUInt32BE(4);        // next 32 bits = 53 total
	return (hi * 0x100000000 + lo) / 0x20000000000000; // / 2^53
}

/**
 * Builds the RNG seed string used by pack opening. Exposed so games that
 * implement their own selection logic can reuse the deterministic format
 * without reimplementing the canonical layout.
 *
 * Fields are joined with `:` — safe today because none of the expected
 * values (hex txIds, `seed_…`/`nft_…` ids, `pack_…` ids, Hive usernames,
 * integers) contain a literal colon. Changing this format breaks
 * reproducibility of any previously published pack opening.
 */
export function buildPackOpenSeed(params: {
	readonly txId: string;
	readonly operationId: string;
	readonly blockNum: number;
	readonly owner: string;
	readonly packDefinitionId: string;
	readonly packIndex: number;
}): string {
	return `${params.txId}:${params.operationId}:${params.blockNum}:${params.owner}:${params.packDefinitionId}:${params.packIndex}`;
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
