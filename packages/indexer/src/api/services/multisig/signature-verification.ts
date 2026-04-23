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

export type FetchActive = (account: string) => Promise<HiveActiveAuthority>;

export type VerifyBuyerSignatureInput = Readonly<{
	readonly buyer: string;
	readonly buyerSignature: string;
	readonly digestBytes: Uint8Array;
	/** Injectable for tests; defaults to Hive `condenser_api.get_accounts`. */
	readonly fetchActive?: FetchActive;
}>;

// Depth cap on `account_auths` delegation resolution. Mirrors Hive's
// consensus constant HIVE_MAX_SIG_CHECK_DEPTH (2) — signatures reachable only
// via a longer chain do not satisfy Hive's own authority check, so following
// them off-chain would be strictly more permissive than consensus.
const MAX_AUTHORITY_DEPTH = 2;

/**
 * Cryptographically verifies that `buyerSignature` was produced by a public
 * key that reaches `buyer`'s active authority threshold, following
 * `account_auths` delegation chains up to Hive's consensus depth
 * (HIVE_MAX_SIG_CHECK_DEPTH = 2). Accepts:
 *
 *   - direct signing keys listed in `buyer.active.key_auths`,
 *   - keys listed in the `active.key_auths` of any account reachable through
 *     `buyer.active.account_auths` at depth ≤ 2, when the delegation chain
 *     accumulates enough weight to meet each intermediate account's threshold.
 *
 * Rejects structurally-valid signatures that do not recover to any reachable
 * key (the VUL-001 scenario — 130 random hex chars fails at the recovery
 * step) and signatures whose accumulated weight is below the threshold.
 *
 * Delegation fetch failures (account deleted, RPC miss) are treated as
 * contributing 0 weight — the buyer's verification falls back to its other
 * authority paths, matching what Hive's own consensus would produce.
 */
export async function verifyBuyerSignatureOrThrow(input: VerifyBuyerSignatureInput): Promise<void> {
	const recoveredKey = recoverPublicKey(input.buyerSignature, input.digestBytes);
	const fetcher = input.fetchActive ?? fetchActiveAuthorityFromHive;
	const active = await fetcher(input.buyer);
	await assertKeyMeetsThreshold(recoveredKey, active, input.buyer, fetcher);
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

type ResolutionContext = Readonly<{
	readonly recoveredKey: string;
	readonly fetch: FetchActive;
	readonly visited: ReadonlySet<string>;
	readonly remainingDepth: number;
}>;

async function assertKeyMeetsThreshold(
	recoveredKey: string,
	active: HiveActiveAuthority,
	buyer: string,
	fetch: FetchActive,
): Promise<void> {
	const threshold = toFiniteNumber(active.weight_threshold);
	if (threshold === null || threshold <= 0) {
		throw createMultisigError(
			"INTERNAL_ERROR",
			`Buyer '${buyer}' active authority has invalid weight_threshold`,
		);
	}

	const accumulated = await computeSigningWeight(active, threshold, {
		recoveredKey,
		fetch,
		visited: new Set<string>([buyer]),
		remainingDepth: MAX_AUTHORITY_DEPTH,
	});

	if (accumulated >= threshold) return;

	throw createMultisigError(
		"INVALID_BUYER_SIGNATURE",
		`Buyer '${buyer}' signature reaches weight ${accumulated}; active threshold ${threshold} requires additional authority`,
	);
}

/**
 * Sums the authority weight a single `recoveredKey` contributes to `active`.
 * Walks `key_auths` first (zero RPC cost; short-circuits on threshold) and
 * only descends into `account_auths` when direct keys cannot cover the gap.
 * The recursion is bounded by `remainingDepth` (Hive's HIVE_MAX_SIG_CHECK_DEPTH)
 * and `visited` guards against delegation cycles.
 *
 * Returns the accumulated weight the caller must compare against its own
 * threshold. Pure reduction: no state mutation, no side effects beyond the
 * injected `fetch`.
 */
async function computeSigningWeight(
	active: HiveActiveAuthority,
	threshold: number,
	ctx: ResolutionContext,
): Promise<number> {
	let weight = 0;

	for (const entry of active.key_auths) {
		const [pubKeyStr, rawWeight] = entry;
		if (!equalPublicKeys(pubKeyStr, ctx.recoveredKey)) continue;
		const w = toFiniteNumber(rawWeight);
		if (w === null) continue;
		weight += w;
		if (weight >= threshold) return weight;
	}

	if (ctx.remainingDepth <= 0) return weight;

	for (const entry of active.account_auths) {
		const [delegatedAccount, rawWeight] = entry;
		if (ctx.visited.has(delegatedAccount)) continue;
		const delegationWeight = toFiniteNumber(rawWeight);
		if (delegationWeight === null) continue;

		let delegatedActive: HiveActiveAuthority;
		try {
			delegatedActive = await ctx.fetch(delegatedAccount);
		} catch {
			// Broken delegation (deleted account, RPC miss) contributes 0. The
			// buyer's direct key_auths and other delegation branches are still
			// evaluated, matching Hive's own fail-open-on-branch behavior.
			continue;
		}

		const delegatedThreshold = toFiniteNumber(delegatedActive.weight_threshold);
		if (delegatedThreshold === null || delegatedThreshold <= 0) continue;

		const nextCtx: ResolutionContext = {
			recoveredKey: ctx.recoveredKey,
			fetch: ctx.fetch,
			visited: new Set([...ctx.visited, delegatedAccount]),
			remainingDepth: ctx.remainingDepth - 1,
		};
		const delegatedWeight = await computeSigningWeight(
			delegatedActive,
			delegatedThreshold,
			nextCtx,
		);

		// A delegated account contributes its delegation weight only if it can
		// itself produce a valid signature from `recoveredKey` — i.e. its own
		// accumulated weight meets its own threshold. This is the recursive
		// form of "B can sign for A iff B can sign for itself".
		if (delegatedWeight >= delegatedThreshold) {
			weight += delegationWeight;
			if (weight >= threshold) return weight;
		}
	}

	return weight;
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
