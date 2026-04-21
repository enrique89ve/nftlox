import type { Queryable } from "@/db/client.ts";

// Request body accepted by POST /api/buy.
export type BuyRequest = Readonly<{
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly buyer: string;
	// Serialized, buyer-signed tx2 — JSON string of a full Hive TransactionType:
	// `{ ref_block_num, ref_block_prefix, expiration, operations, extensions, signatures }`.
	// The indexer rehydrates it, appends the node active signature, and
	// broadcasts. Format documented at the top of build-buy.ts.
	readonly presignedTx2: string;
}>;

// Normalized, validated input built at the route boundary.
export type ValidatedBuyRequest = Readonly<{
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly buyer: string;
	readonly presignedTx2: string;
}>;

// Response shape.
export type BuyResponse =
	| Readonly<{
		readonly ok: true;
		readonly status: "confirmed";
		readonly tx1Id: string;
		readonly tx2Id: string;
	}>
	| Readonly<{
		readonly ok: false;
		readonly code: string;
		readonly message: string;
		readonly retryAfterMs?: number;
	}>;

// Information about the broadcast tx1 (sale_lock) needed downstream.
export type SaleLockBroadcastResult = Readonly<{
	readonly txId: string;
	readonly operationId: string;
	readonly blockNum: number | null;
}>;

// Context injected by the route into the orchestrator. Carrying these
// explicitly keeps the service testable without reaching into module-level
// singletons (sql, config).
export type BuyContext = Readonly<{
	readonly db: Queryable;
	readonly nodeAccount: string;
	readonly protocolId: string;
	readonly lagMaxBlocks: number;
	readonly maxActiveLocksPerBuyer: number;
	readonly saleLockDurationBlocks: number;
	readonly buyTxTtlMs: number;
}>;
