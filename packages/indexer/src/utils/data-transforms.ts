// Pure data transformation functions.
// Zero I/O — testable with plain objects.

import { computeDataHash, validateMutableUpdate, type CollectionSchema } from "nftlox-sdk";

export const formatSchemaErrors = (
	errors: ReadonlyArray<{ readonly field: string; readonly message: string }>,
): string =>
	errors.map((e) => `${e.field}: ${e.message}`).join("; ");

export const validateAndMergeMutableData = async (
	schema: CollectionSchema,
	incoming: Record<string, unknown>,
	existing: Record<string, unknown> | null,
): Promise<{ readonly merged: Record<string, unknown>; readonly dataHash: string }> => {
	const errors = validateMutableUpdate(schema, incoming);
	if (errors.length > 0) {
		throw new Error(`Schema validation failed: ${formatSchemaErrors(errors)}`);
	}

	const merged = { ...(existing ?? {}), ...incoming };
	const dataHash = await computeDataHash(merged);
	return { merged, dataHash };
};
