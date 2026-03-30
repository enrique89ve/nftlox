// SPV "Boleto Suizo" - Constants

export const DEFAULT_HIVE_ENDPOINTS = [
	"https://api.hive.blog",
	"https://api.syncad.com",
	"https://rpc.mahdiyari.info",
	"https://anyx.io",
] as const;

// Wax default: 2_000ms (IWaxOptionsChain.apiTimeout)
// SPV needs more margin for HAFAH REST lookups (heavier than JSON-RPC)
export const DEFAULT_HIVE_TIMEOUT_MS = 4_000;
export const DEFAULT_AUDIT_SAMPLE_SIZE = 3;

/**
 * Builds the RNG seed for pack_open verification.
 * Must match exactly: pack-open.ts line 49.
 */
export function buildRngSeed(
	txId: string,
	blockNum: number,
	signer: string,
	packId: string,
	packIndex: number,
): string {
	return `${txId}:${blockNum}:${signer}:${packId}:${packIndex}`;
}

/**
 * Selects a random sample from an array without replacement.
 * Uses Fisher-Yates partial shuffle for unbiased selection.
 */
export function selectRandomSample<T>(items: ReadonlyArray<T>, count: number): T[] {
	const copy = [...items];
	const selected: T[] = [];

	for (let i = 0; i < count && copy.length > 0; i++) {
		const index = Math.floor(Math.random() * copy.length);
		selected.push(copy[index]!);
		copy.splice(index, 1);
	}

	return selected;
}
