import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";

export async function handleDeprecatedSaleLock(
	_op: ParsedOperation,
	_txn: Queryable,
): Promise<ReadonlyArray<string>> {
	throw new Error("sale_lock is deprecated — buy must be settled in a single transaction");
}
