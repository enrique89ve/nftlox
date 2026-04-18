import type { IndexerNftSummary } from "./client";

/** Campos que un instance hereda del seed cuando son null/vacios */
const INHERITABLE_FIELDS = ["name", "image_url", "origin_dna", "immutable_data"] as const;

/** Merge instance delta con seed data. Retorna objeto completo. */
export function resolveInstance<T extends IndexerNftSummary>(
	instance: T,
	seed: IndexerNftSummary,
): T {
	const resolved = { ...instance };
	for (const field of INHERITABLE_FIELDS) {
		const value = resolved[field];
		if (value === null || value === undefined || value === "") {
			(resolved as Record<string, unknown>)[field] = seed[field];
		}
	}
	return resolved;
}
