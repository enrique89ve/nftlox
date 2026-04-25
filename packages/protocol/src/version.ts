// Canonical semver helpers for protocol versions.
//
// The protocol uses strict numeric semver (`X.Y.Z`, no prerelease, no build
// metadata) on the wire — historical chain operations carry exactly that
// shape. Anything else is rejected at parse time so downstream comparators
// can trust their inputs and short-circuit on malformed data without
// silently treating it as "0.0.0".
//
// This module replaces three pre-existing copies of the same logic
// (indexer scanner, indexer multisig, SDK SPV) with a single source of
// truth. New consumers must import from here.

import { MIN_PROTOCOL_VERSION } from "./constants";

export const PROTOCOL_VERSION_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type ProtocolVersionParts = readonly [number, number, number];

/**
 * Parses a protocol version string into `[major, minor, patch]`. Returns
 * `null` for any string that does not match strict numeric semver — that
 * includes leading zeros (`01.0.0`), prerelease tags (`1.0.0-rc1`), build
 * metadata (`1.0.0+abc`), and non-string inputs.
 */
export function parseProtocolVersion(value: unknown): ProtocolVersionParts | null {
	if (typeof value !== "string") return null;
	const match = PROTOCOL_VERSION_REGEX.exec(value);
	if (!match) return null;

	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (
		!Number.isSafeInteger(major) ||
		!Number.isSafeInteger(minor) ||
		!Number.isSafeInteger(patch)
	) {
		return null;
	}
	return [major, minor, patch];
}

/** Predicate form. */
export function isValidProtocolVersion(value: unknown): value is string {
	return parseProtocolVersion(value) !== null;
}

/** Throws with a descriptive error when `value` is not a valid version. */
export function assertValidProtocolVersion(value: unknown): asserts value is string {
	if (!isValidProtocolVersion(value)) {
		throw new Error(
			`Invalid protocol version: ${JSON.stringify(value)} (expected strict semver "X.Y.Z")`,
		);
	}
}

/**
 * Compares two protocol versions. Returns -1 / 0 / 1.
 *
 * Throws if either input is not a valid protocol version — callers that
 * may receive untrusted strings (chain payloads, HTTP bodies) must use
 * `parseProtocolVersion()` to validate first or wrap the call in their
 * own try/catch. The throw is deliberate: returning `0` for malformed
 * input would silently treat garbage as the current version.
 */
export function compareVersions(a: string, b: string): number {
	const partsA = parseProtocolVersion(a);
	const partsB = parseProtocolVersion(b);
	if (!partsA || !partsB) {
		throw new Error(`Invalid protocol version comparison: '${a}' vs '${b}'`);
	}
	for (let i = 0; i < 3; i++) {
		const numA = partsA[i] ?? 0;
		const numB = partsB[i] ?? 0;
		if (numA !== numB) return numA < numB ? -1 : 1;
	}
	return 0;
}

/**
 * Whether `version` is well-formed AND at least `MIN_PROTOCOL_VERSION`.
 * Convenience for indexer-side payload acceptance.
 */
export function isAcceptedProtocolVersion(value: unknown): value is string {
	if (!isValidProtocolVersion(value)) return false;
	return compareVersions(value, MIN_PROTOCOL_VERSION) >= 0;
}

/**
 * Throws when `value` is not accepted by the current protocol. Used by
 * write-path validators (SDK builders, indexer accept paths) where any
 * acceptable version must be both well-formed and >= MIN.
 */
export function assertAcceptedProtocolVersion(value: unknown): asserts value is string {
	assertValidProtocolVersion(value);
	if (compareVersions(value, MIN_PROTOCOL_VERSION) < 0) {
		throw new Error(
			`Protocol version ${value} is below MIN_PROTOCOL_VERSION (${MIN_PROTOCOL_VERSION})`,
		);
	}
}
