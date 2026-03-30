// ============ BRANDED TYPE: ListingTxId ============
// Compile-time safety for marketplace listing tx references.
// Prevents accidentally passing a generic txId where a listing txId is expected.

import { TX_ID_REGEX } from "./constants";

type Brand<T, B extends string> = T & { readonly __brand: B };

/** Hive txId where a marketplace listing was created. */
export type ListingTxId = Brand<string, "ListingTxId">;

export function asListingTxId(raw: string): ListingTxId {
	if (!TX_ID_REGEX.test(raw)) {
		throw new Error(`Invalid ListingTxId: expected 40-char hex, got "${raw}"`);
	}
	return raw as ListingTxId;
}
