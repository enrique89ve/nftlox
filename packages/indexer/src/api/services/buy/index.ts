// Orchestrator for POST /api/buy. Coordinates the six-step buy flow:
//   1. Sync-lag gate — indexer must be within lagMaxBlocks of Hive HEAD.
//   2. Settlement node check — the node itself must be `active` for settlement.
//   3. Pre-tx1 validation — validatePresignedTx2 + per-buyer sale_lock cap.
//   4. Broadcast tx1 (sale_lock) signed with node posting key.
//   5. Await tx1 projection into the indexer (confirmed or rejected).
//   6. Cosign and broadcast tx2 — buyer already active-signed the transfers +
//      buy custom_json; the node appends its active signature.
//
// Why BOTH pre-tx1 validation AND post-tx1 inclusion await: steps 3 and 5 are
// load-bearing for different failure modes. Step 3 catches obvious rejects
// cheaply — no L1 tx goes out for malformed requests, and buyers don't starve
// for SALE_LOCK_DURATION_BLOCKS on a sloppy payload. Step 5 catches the
// narrow race where the NFT was legitimately valid at step 3 but the
// sale_lock handler rejects at commit time (e.g., listing got unlisted within
// the tiny window between validation and handler run).
//
// Why we broadcast tx1 BEFORE attempting to cosign tx2: the pending_sale
// reservation is the thing that prevents a double-spend between concurrent
// buyers. If we cosigned and broadcast tx2 without a prior sale_lock, two
// buyers could race and both get their transfers credited while only one
// receives the NFT. tx1 is the serialization point.
//
// CONFIDENCE: HIGH on the step ordering — matches the protocol contract
// documented in packages/protocol/src/constants.ts. MEDIUM on the per-buyer
// lock cap query — simple COUNT(*) with the existing partial index; see
// countActiveSaleLocksForBuyer below.

import { assertActiveSettlementNode } from "@/db/queries/nodes.ts";
import {
	BUY_API_LAG_MAX_BLOCKS,
	MAX_ACTIVE_SALE_LOCKS_PER_BUYER,
	SALE_LOCK_DURATION_BLOCKS,
} from "@/protocol/index.ts";
import { createBuyError } from "./errors.ts";
import { validatePresignedTx2 } from "./validate-presigned-tx2.ts";
import { broadcastSaleLock } from "./broadcast-sale-lock.ts";
import { awaitTx1Inclusion } from "./await-tx1-inclusion.ts";
import { cosignAndBroadcastTx2 } from "./cosign-and-broadcast-tx2.ts";
import type { Queryable } from "@/db/client.ts";
import type { BuyContext, BuyResponse, ValidatedBuyRequest } from "./types.ts";

const HIVE_BLOCK_TIME_MS = 3000;

export async function processBuy(
	ctx: BuyContext,
	request: ValidatedBuyRequest,
): Promise<BuyResponse> {
	await assertSyncHealthy(ctx);
	await assertNodeActive(ctx);

	const validated = await validatePresignedTx2(request, ctx.nodeAccount, ctx.db);
	await assertBuyerLockCap(request.buyer, ctx.maxActiveLocksPerBuyer, ctx.db);

	const tx1 = await broadcastSaleLock(
		{ nftId: request.nftId, listingId: request.listingId, listTxId: request.listTxId, buyer: request.buyer },
		ctx.nodeAccount,
	);
	// REVIEW: from here on the NFT is reserved on L1 for SALE_LOCK_DURATION_BLOCKS.
	// Any early-return that doesn't resolve into a broadcast tx2 will lose the
	// buyer the ability to re-attempt for that window. The lazy sweep in
	// sync-engine reclaims the listing automatically at expiry — we never
	// emit a compensating unlock op.
	await awaitTx1Inclusion(tx1.txId, ctx.saleLockDurationBlocks);

	const tx2 = await cosignAndBroadcastTx2(validated.parsed);

	return { ok: true, status: "confirmed", tx1Id: tx1.txId, tx2Id: tx2.tx2Id };
}

async function assertSyncHealthy(ctx: BuyContext): Promise<void> {
	const snapshot = await readSyncState(ctx.db);
	const lag = snapshot.hiveHeadBlock - snapshot.lastBlock;
	if (lag > ctx.lagMaxBlocks) {
		const retryAfterMs = estimateLagRetryMs(lag, ctx.lagMaxBlocks);
		throw createBuyError(
			"INDEXER_LAGGED",
			`Indexer is ${lag} blocks behind Hive HEAD (max ${ctx.lagMaxBlocks}); retry in ~${retryAfterMs}ms`,
			{ retryAfterMs },
		);
	}
}

async function assertNodeActive(ctx: BuyContext): Promise<void> {
	// We evaluate node liveness against `last_block` (the indexer's current
	// projection cursor), NOT hive_head — the same block the sale_lock handler
	// will see when it runs. Prevents a node from successfully broadcasting
	// tx1 only to have the handler reject its own sale_lock as stale.
	const snapshot = await readSyncState(ctx.db);
	try {
		await assertActiveSettlementNode(ctx.nodeAccount, snapshot.lastBlock, ctx.db);
	} catch (cause) {
		throw createBuyError(
			"NODE_NOT_ACTIVE",
			cause instanceof Error ? cause.message : "Settlement node is not active",
			{ cause },
		);
	}
}

async function assertBuyerLockCap(
	buyer: string,
	cap: number,
	db: Queryable,
): Promise<void> {
	const active = await countActiveSaleLocksForBuyer(buyer, db);
	if (active >= cap) {
		// Hive block time is 3s, so the shortest possible expiry of the oldest
		// lock bounds the retry window. We surface that as retryAfterMs so the
		// client can back off deterministically.
		const retryAfterMs = SALE_LOCK_DURATION_BLOCKS * HIVE_BLOCK_TIME_MS;
		throw createBuyError(
			"TOO_MANY_ACTIVE_LOCKS",
			`Buyer '${buyer}' has ${active} active sale_lock reservations (max ${cap}); wait for one to expire or settle`,
			{ retryAfterMs },
		);
	}
}

async function countActiveSaleLocksForBuyer(buyer: string, db: Queryable): Promise<number> {
	// Uses idx_nfts_sale_buyer_pending (partial index on sale_buyer WHERE
	// status='pending_sale') for an index-only COUNT. Expired locks are
	// cleaned up lazily by sync-engine — they stop counting here the moment
	// the sweep flips them back to 'listed'.
	const [row] = await db`
		SELECT COUNT(*)::int AS c
		FROM nfts
		WHERE status = 'pending_sale' AND sale_buyer = ${buyer}
	`;
	return Number(row?.c ?? 0);
}

type SyncStateSnapshot = Readonly<{ readonly lastBlock: number; readonly hiveHeadBlock: number }>;

async function readSyncState(db: Queryable): Promise<SyncStateSnapshot> {
	const [row] = await db`SELECT last_block, hive_head_block FROM sync_state WHERE id = 1`;
	if (!row) {
		throw createBuyError("INTERNAL_ERROR", "sync_state row missing — indexer not initialized");
	}
	const lastBlock = Number(row.last_block);
	const hiveHeadBlock = Number(row.hive_head_block);
	if (!Number.isFinite(lastBlock) || !Number.isFinite(hiveHeadBlock)) {
		throw createBuyError("INTERNAL_ERROR", "sync_state row has invalid block numbers");
	}
	return { lastBlock, hiveHeadBlock };
}

function estimateLagRetryMs(lag: number, lagMaxBlocks: number): number {
	// Back-pressure the client long enough that the indexer can catch up
	// (overshoot the deficit by one block) so a naive retry loop converges
	// rather than hammering the API.
	const deficit = Math.max(1, lag - lagMaxBlocks + 1);
	return deficit * HIVE_BLOCK_TIME_MS;
}

// Re-export the protocol defaults so routes constructing a BuyContext do not
// have to touch @/protocol directly — keeps the public entry point for this
// service a single module.
export const BUY_SERVICE_DEFAULTS = {
	lagMaxBlocks: BUY_API_LAG_MAX_BLOCKS,
	maxActiveLocksPerBuyer: MAX_ACTIVE_SALE_LOCKS_PER_BUYER,
	saleLockDurationBlocks: SALE_LOCK_DURATION_BLOCKS,
} as const;

export type { BuyContext, BuyRequest, BuyResponse, ValidatedBuyRequest } from "./types.ts";
export { BuyError, isBuyError } from "./errors.ts";
