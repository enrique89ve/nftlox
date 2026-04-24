import type { IndexerNftSummary } from "./client";

/** Fields an instance inherits from its seed when they are null or empty. */
const INHERITABLE_FIELDS = ["name", "image_url", "origin_dna", "immutable_data"] as const;

/** Merges the instance delta with seed data and returns the resolved object. */
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
