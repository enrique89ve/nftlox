// Runtime CASTS for ProtocolPayload narrowing. Every helper in this file
// is a trust-boundary escape hatch: it performs the cheapest possible
// discriminator check and then returns the payload at a narrower static type
// WITHOUT inspecting the embedded `data` fields.
//
// Callers MUST perform explicit runtime validation of `data` (Zod, manual
// guards, or the DB-schema crosscheck a handler already does) before trusting
// any field. The casts exist so that once the caller has independently proven
// the payload is well-formed, subsequent type-narrowed lookups compile cleanly.
//
// File name and function names are deliberately loud so that every import
// site reads as "cast, not validate" — if you see a call to one of these
// helpers and upstream validation is unclear, that is a review finding.

import type { ProtocolAction } from "./constants";
import type { ProtocolPayload, TypedProtocolPayload } from "./types";

/**
 * Assumes `payload.action === action` and casts `data` to the matching
 * `PayloadDataByAction[A]` shape.
 *
 * Returns `null` when the discriminator does not match — use this as a
 * short-circuit when the same helper routes multiple payload shapes.
 */
export function castPayloadByAction<A extends ProtocolAction>(
	payload: ProtocolPayload<Record<string, unknown>>,
	action: A,
): TypedProtocolPayload<A> | null {
	if (payload.action !== action) return null;
	return payload as TypedProtocolPayload<A>;
}
