// NFTLox Protocol - Playground Utility Functions

import {
	SYMBOL_CLEANUP_REGEX,
	SYMBOL_MAX_LENGTH,
	SYMBOL_MIN_LENGTH,
	SYMBOL_PAD_CHARACTER,
} from "./constants";

// ============ SYMBOL NORMALIZATION ============

/**
 * Normalizes a symbol to NFTLox protocol standards.
 * Converts to uppercase, removes invalid characters, and ensures length constraints.
 */
export function normalizeSymbolForCollection(input: string): string {
	const cleaned = input
		.slice(0, SYMBOL_MAX_LENGTH)
		.toUpperCase()
		.replace(SYMBOL_CLEANUP_REGEX, "");

	if (cleaned.length >= SYMBOL_MIN_LENGTH) {
		return cleaned;
	}

	return cleaned.padEnd(SYMBOL_MIN_LENGTH, SYMBOL_PAD_CHARACTER);
}

/**
 * Generates a symbol from a collection name.
 * Takes first N characters, normalizes them, and ensures valid format.
 */
export function generateSymbolFromName(collectionName: string): string {
	const truncated = collectionName.slice(0, SYMBOL_MAX_LENGTH);
	return normalizeSymbolForCollection(truncated);
}

// ============ ARRAY SAFETY ============

/**
 * Safely accesses array element with explicit error handling.
 */
export function getArrayElement<T>(array: T[], index: number, context: string): T {
	const element = array[index];
	if (element === undefined) {
		throw new Error(`[${context}] Array index ${index} out of bounds (length: ${array.length})`);
	}
	return element;
}

/**
 * Checks if an array index is valid.
 */
export function isValidIndex<T>(array: T[], index: number): boolean {
	return index >= 0 && index < array.length;
}
