import { PublicKey, Signature, callRPC } from "hive-tx";
import { createMultisigError } from "@/api/services/multisig/errors.ts";

// Shape of the `active` authority entry as returned by
// `condenser_api.get_accounts`. Hive returns weights and thresholds as numbers
// encoded either as `number` or `string` depending on the node build — we
// normalize both before comparing.
type HiveKeyAuth = readonly [string, number | string];

export type HiveActiveAuthority = Readonly<{
	readonly weight_threshold: number | string;
	readonly account_auths: ReadonlyArray<readonly [string, number | string]>;
	readonly key_auths: ReadonlyArray<HiveKeyAuth>;
}>;

type HiveAccountRow = Readonly<{
	readonly name: string;
	readonly active: HiveActiveAuthority;
}>;

export type VerifyBuyerSignatureInput = Readonly<{
	readonly buyer: string;
	readonly buyerSignature: string;
	readonly digestBytes: Uint8Array;
	/** Injectable for tests; defaults to Hive `condenser_api.get_accounts`. */
	readonly fetchActive?: (buyer: string) => Promise<HiveActiveAuthority>;
}>;

/**
 * Cryptographically verifies that `buyerSignature` was produced by a public
 * key listed in `buyer`'s active authority with sufficient weight to meet the
 * authority threshold on its own. Rejects signatures that are structurally
 * valid but do not recover to an authorized key — the attacker scenario
 * described in VUL-001 (130 random hex chars) fails at the recovery step.
 *
 * Limitations: does not resolve `active.account_auths` (delegated authority to
 * another Hive account). Buyers whose active authority only grants signing
 * power through delegations must sign with a directly-listed key.
 */
export async function verifyBuyerSignatureOrThrow(input: VerifyBuyerSignatureInput): Promise<void> {
	const recoveredKey = recoverPublicKey(input.buyerSignature, input.digestBytes);
	const fetcher = input.fetchActive ?? fetchActiveAuthorityFromHive;
	const active = await fetcher(input.buyer);
	assertKeyMeetsThreshold(recoveredKey, active, input.buyer);
}

function recoverPublicKey(buyerSignature: string, digestBytes: Uint8Array): string {
	try {
		const signature = Signature.from(buyerSignature);
		const pubKey = signature.getPublicKey(digestBytes);
		return pubKey.toString();
	} catch (cause) {
		throw createMultisigError(
			"INVALID_BUYER_SIGNATURE",
			"Buyer signature is not a valid ECDSA signature for this transaction",
			{ cause },
		);
	}
}

async function fetchActiveAuthorityFromHive(buyer: string): Promise<HiveActiveAuthority> {
	let rows: ReadonlyArray<HiveAccountRow>;
	try {
		rows = await callRPC<ReadonlyArray<HiveAccountRow>>("condenser_api.get_accounts", [[buyer]]);
	} catch (cause) {
		throw createMultisigError(
			"INTERNAL_ERROR",
			`Failed to fetch active authority for buyer '${buyer}'`,
			{ cause },
		);
	}

	const [row] = rows;
	if (!row || row.name !== buyer || !row.active) {
		throw createMultisigError(
			"INVALID_BUYER_SIGNATURE",
			`Buyer account '${buyer}' not found on Hive`,
		);
	}

	return row.active;
}

function assertKeyMeetsThreshold(
	recoveredKey: string,
	active: HiveActiveAuthority,
	buyer: string,
): void {
	const threshold = toFiniteNumber(active.weight_threshold);
	if (threshold === null || threshold <= 0) {
		throw createMultisigError(
			"INTERNAL_ERROR",
			`Buyer '${buyer}' active authority has invalid weight_threshold`,
		);
	}

	for (const entry of active.key_auths) {
		const [pubKeyStr, rawWeight] = entry;
		if (!equalPublicKeys(pubKeyStr, recoveredKey)) continue;

		const weight = toFiniteNumber(rawWeight);
		if (weight === null) continue;
		if (weight >= threshold) return;

		throw createMultisigError(
			"INVALID_BUYER_SIGNATURE",
			`Buyer '${buyer}' signed with key '${pubKeyStr}' (weight ${weight}); active threshold ${threshold} requires additional signatures`,
		);
	}

	throw createMultisigError(
		"INVALID_BUYER_SIGNATURE",
		`Buyer signature does not recover to any key in '${buyer}' active authority`,
	);
}

function equalPublicKeys(a: string, b: string): boolean {
	try {
		return PublicKey.from(a).toString() === PublicKey.from(b).toString();
	} catch {
		return a === b;
	}
}

function toFiniteNumber(value: number | string): number | null {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
