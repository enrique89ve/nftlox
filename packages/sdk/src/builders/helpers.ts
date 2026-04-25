import type { ZodError } from "zod";
import { readDeclaredProvenance, type SeedProvenance } from "@nftlox/protocol";
import type { ValidationError } from "./types";

export function formatZodError(error: ZodError): ValidationError[] {
	return error.issues.map((issue) => ({
		field: issue.path.join("."),
		message: issue.message,
		code: issue.code.toUpperCase(),
	}));
}

/**
 * Returns the declared seed-provenance attestation as a spreadable object.
 *
 * Routes through `@nftlox/protocol`'s canonical parser so the SDK and the
 * indexer cannot drift on what counts as a valid attestation. Returns an
 * empty object when no field is declared, so callers can use the spread
 * pattern uniformly:
 *
 *   const payload: TransferData = {
 *     nftId, to,
 *     ...withProvenance(input),
 *   };
 *
 * The Zod input schema already rejects malformed values; this is a
 * belt-and-suspenders pass to guarantee we never emit a payload the indexer
 * would reject for provenance shape alone.
 */
export function withProvenance(input: {
	readonly seedId?: string | undefined;
	readonly seedTxId?: string | undefined;
}): SeedProvenance {
	const declared = readDeclaredProvenance(input as Record<string, unknown>);
	return declared ?? {};
}
