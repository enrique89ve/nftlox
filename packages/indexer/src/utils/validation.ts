/**
 * Runtime validation helpers for extracting typed values from unknown data.
 * Replaces blind `as` casts with fail-fast runtime checks at system boundaries.
 */

export function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || value === "") {
		throw new Error(`Missing or invalid ${fieldName}: expected non-empty string`);
	}
	return value;
}

export function requireNumber(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new Error(`Missing or invalid ${fieldName}: expected number`);
	}
	return value;
}

export function optionalString(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") return null;
	return value;
}

export function optionalNumber(value: unknown, fallback?: number): number | null {
	if (value === undefined || value === null) return fallback ?? null;
	if (typeof value !== "number" || Number.isNaN(value)) return fallback ?? null;
	return value;
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	return fallback;
}

export function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Missing or invalid ${fieldName}: expected object`);
	}
	return value as Record<string, unknown>;
}

export function optionalObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export function optionalStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter((v): v is string => typeof v === "string");
}

export function requirePrice(value: unknown, fieldName: string): { amount: string; currency: string } {
	const obj = requireObject(value, fieldName);
	return {
		amount: requireString(obj.amount, `${fieldName}.amount`),
		currency: requireString(obj.currency, `${fieldName}.currency`),
	};
}
