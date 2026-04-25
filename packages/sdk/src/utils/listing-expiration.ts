// Ergonomic helpers for constructing the absolute Unix-ms timestamp the
// `list` action expects in `expiresAt`. Game / app code should never compute
// `Date.now() + n * 86_400_000` inline — these helpers prevent unit confusion
// (s vs ms) and make TTL intent obvious at the call site.
//
// Validation of the resulting timestamp against MIN/MAX bounds is the SDK
// schema's job; these are pure constructors.

import { MIN_LISTING_TTL_MS, MAX_LISTING_TTL_MS } from "@nftlox/protocol";

export type ExpireInOptions = {
	readonly days?: number;
	readonly hours?: number;
	readonly minutes?: number;
};

/**
 * Returns an absolute Unix-ms timestamp `now + duration`, where `duration`
 * is summed from the supplied units. At least one unit must be provided.
 *
 * Example:
 *   buildList({ ..., expiresAt: expireIn({ days: 14 }) })
 *
 * Throws when no unit is provided, when any unit is non-finite, or when the
 * resulting offset falls outside [MIN_LISTING_TTL_MS, MAX_LISTING_TTL_MS].
 * The throw is intentional: a silently-clamped TTL would be harder to debug
 * than a loud error at the call site.
 */
export function expireIn(opts: ExpireInOptions): number {
	const { days = 0, hours = 0, minutes = 0 } = opts;
	if (![days, hours, minutes].every(Number.isFinite)) {
		throw new Error("expireIn: every duration unit must be a finite number");
	}
	const ms = days * 86_400_000 + hours * 3_600_000 + minutes * 60_000;
	if (ms <= 0) {
		throw new Error("expireIn: total duration must be positive (provide at least one unit)");
	}
	if (ms < MIN_LISTING_TTL_MS) {
		throw new Error(
			`expireIn: total duration ${ms}ms is below MIN_LISTING_TTL_MS (${MIN_LISTING_TTL_MS}ms)`,
		);
	}
	if (ms > MAX_LISTING_TTL_MS) {
		throw new Error(
			`expireIn: total duration ${ms}ms exceeds MAX_LISTING_TTL_MS (${MAX_LISTING_TTL_MS}ms)`,
		);
	}
	return Date.now() + ms;
}

/**
 * Returns the absolute Unix-ms timestamp from a `Date` or ISO 8601 string.
 * Useful when the seller picks a calendar date in a UI date picker.
 *
 * Throws on invalid input or when the target falls outside the protocol's
 * accepted listing window relative to the current wall clock. The MIN/MAX
 * checks here are advisory (the indexer compares against the block timestamp,
 * not `Date.now()`); they exist to fail-fast in the build step.
 */
export function expireAt(target: Date | string): number {
	const ms = typeof target === "string" ? Date.parse(target) : target.getTime();
	if (!Number.isFinite(ms)) {
		throw new Error(`expireAt: invalid date input '${String(target)}'`);
	}
	const offset = ms - Date.now();
	if (offset < MIN_LISTING_TTL_MS) {
		throw new Error(
			`expireAt: target is too soon — must be at least ${MIN_LISTING_TTL_MS}ms in the future`,
		);
	}
	if (offset > MAX_LISTING_TTL_MS) {
		throw new Error(
			`expireAt: target is too far — must be at most ${MAX_LISTING_TTL_MS}ms in the future`,
		);
	}
	return ms;
}
