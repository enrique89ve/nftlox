// SDK-only artId utilities for anti-duplication minting flows.
// Not part of the on-chain protocol — used by UIs that resolve duplicate
// seedIds deterministically from user-provided names.

import { generateHash } from "@nftlox/protocol";

export type ArtIdValidationResult = {
	readonly valid: boolean;
	readonly error?: string | undefined;
};

const ART_ID_SUFFIX_LENGTH = 2;
const ART_ID_MAX_SLUG_LENGTH = 32 - 1 - ART_ID_SUFFIX_LENGTH;

/**
 * Sanitizes a raw string into a valid artId:
 * trims, lowercases, replaces separators with hyphens, strips non-alphanumeric,
 * collapses repeated hyphens, strips leading/trailing hyphens.
 */
export function sanitizeArtId(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Generates a deterministic artId from a seed name.
 * Slugifies then appends a 2-char hex suffix from SHA-256 of the input,
 * so different names that sanitize to the same slug still collide-free.
 */
export async function generateArtIdFromName(name: string): Promise<string> {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new Error("Name is required to generate artId");
	}
	const slug = sanitizeArtId(trimmed).slice(0, ART_ID_MAX_SLUG_LENGTH);
	const hash = await generateHash(`nftlox:artid:${trimmed}`);
	const suffix = hash.slice(0, ART_ID_SUFFIX_LENGTH);
	return `${slug}-${suffix}`;
}

/**
 * Validates an artId:
 * - required, max 32 chars
 * - lowercase alphanumeric + hyphens only
 * - no repeated hyphens, no leading/trailing hyphen
 */
export function validateArtId(artId: string): ArtIdValidationResult {
	if (!artId) return { valid: false, error: "artId is required" };
	if (artId.length > 32) return { valid: false, error: "maximum 32 characters" };
	if (!/^[a-z0-9-]+$/.test(artId)) return { valid: false, error: "only lowercase letters, numbers and hyphens allowed" };
	if (/--/.test(artId)) return { valid: false, error: "repeated hyphens not allowed" };
	if (artId.startsWith("-") || artId.endsWith("-")) return { valid: false, error: "cannot start or end with hyphen" };
	return { valid: true };
}

export type ArtIdArrayValidation = {
	readonly formatErrors: ReadonlyArray<{ readonly index: number; readonly artId: string; readonly error: string }>;
	readonly duplicates: readonly string[];
	readonly valid: boolean;
};

/** Validates each artId's format and reports duplicates (case-insensitive). */
export function validateArtIdArray(artIds: readonly string[]): ArtIdArrayValidation {
	const formatErrors: Array<{ index: number; artId: string; error: string }> = [];
	const seen = new Map<string, number>();
	const duplicates: string[] = [];

	for (let i = 0; i < artIds.length; i++) {
		const artId = artIds[i]!;
		const validation = validateArtId(artId);
		if (!validation.valid) {
			formatErrors.push({ index: i, artId, error: validation.error! });
		}
		const normalized = artId.toLowerCase();
		if (seen.has(normalized)) {
			duplicates.push(artId);
		} else {
			seen.set(normalized, i);
		}
	}

	return {
		formatErrors,
		duplicates: [...new Set(duplicates)],
		valid: formatErrors.length === 0 && duplicates.length === 0,
	};
}
