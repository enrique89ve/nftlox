/**
 * Secret redaction helpers for error messages and stack traces.
 *
 * Hardens the beekeeper-signer boundary: if `@hiveio/beekeeper` ever includes
 * a raw WIF in an error message or stack (arg dump, "failed to import key: X"
 * style), we never propagate it to logs or upstream handlers.
 *
 * Only matches Hive/Bitcoin-style WIF shapes to avoid false positives on
 * legitimate hex digests, signatures, and STM-prefixed public keys.
 */

// Base58 alphabet excludes 0, O, I, l — hence [1-9A-HJ-NP-Za-km-z].
// Hive mainnet WIF: 51 chars, starts with `5`. Compressed K/L variants: 52 chars.
const WIF_5 = /\b5[1-9A-HJ-NP-Za-km-z]{50}\b/g;
const WIF_KL = /\b[KL][1-9A-HJ-NP-Za-km-z]{51}\b/g;

export function redactSecrets(text: string): string {
	if (!text) return text;
	return text.replace(WIF_5, "[REDACTED]").replace(WIF_KL, "[REDACTED]");
}

/**
 * Wraps an arbitrary thrown value in a new Error whose message and stack
 * have been scrubbed of recognizable secrets. Call this at every boundary
 * where a beekeeper/WASM error could otherwise reach logs or bubble up.
 */
export function redactError(err: unknown): Error {
	const rawMessage = extractMessage(err);
	const safe = new Error(redactSecrets(rawMessage));

	if (err instanceof Error && err.stack) {
		safe.stack = redactSecrets(err.stack);
	}

	return safe;
}

function extractMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (err == null) return "unknown error";
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}
