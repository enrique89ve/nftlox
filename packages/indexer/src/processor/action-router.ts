import type { Queryable } from "@/db/client.ts";
import { getStateRootBuffer, getTxSavepointHandle, attachScope } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { createLogger } from "@/utils/logger.ts";
import { config } from "@/config.ts";
import { insertInvalidOperation, insertOrphanedBuy, insertConfirmedOperation, isOperationConfirmed } from "@/db/queries/sync.ts";
import {
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_SET_DATA,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_NODE_REGISTER,
	ACTION_NODE_HEARTBEAT,
	getAuthMismatchReason,
	getPaymentRequirement,
	type PaymentRequirement,
	type ProtocolAction,
} from "@/protocol/index.ts";
import { PAYMENT_VALIDATORS, type PaymentMatch } from "./payment.ts";

// Core
import { handleCreateCollection } from "./handlers/core/create-collection.ts";
import { handleMint } from "./handlers/core/mint.ts";
import { handleBulkDistribute } from "./handlers/core/bulk-distribute.ts";
import { handleTransfer } from "./handlers/core/transfer.ts";
import { handleSetData } from "./handlers/core/set-data.ts";
import { handleExtendSchema } from "./handlers/core/extend-schema.ts";
import { handleArchiveCollection } from "./handlers/core/archive-collection.ts";
import { handleNodeRegister } from "./handlers/core/node_register.ts";
import { handleNodeHeartbeat } from "./handlers/core/node_heartbeat.ts";

// Marketplace
import { handleList } from "./handlers/marketplace/list.ts";
import { handleUnlist } from "./handlers/marketplace/unlist.ts";

import { handleBuy } from "./handlers/marketplace/buy.ts";

// Allowances (Approve & TransferFrom)
import { handleNftApprove } from "./handlers/allowances/nft-approve.ts";
import { handleNftApproveAll } from "./handlers/allowances/nft-approve-all.ts";
import { handleNftTransferFrom } from "./handlers/allowances/nft-transfer-from.ts";

// Data Operators
import { handleDataOperatorApprove } from "./handlers/allowances/data-operator-approve.ts";
import { handleSetDataFrom } from "./handlers/allowances/set-data-from.ts";

// Lending
import { handleNftLend } from "./handlers/lending/nft-lend.ts";
import { handleNftReturn } from "./handlers/lending/nft-return.ts";

const log = createLogger("router");

type Handler = (op: ParsedOperation, txn: Queryable) => Promise<ReadonlyArray<string>>;

function confirmedOperationNftIds(action: ProtocolAction, nftIds: ReadonlyArray<string>): ReadonlyArray<string> {
	if (action === ACTION_BULK_DISTRIBUTE) return [];
	return nftIds;
}

/**
 * Derives the expected fee-transfer memo from the operation payload using
 * the memoKey declared on the PaymentRequirement. Keeps the string format
 * (`NFTLox ${memoTag}:${naturalKey}`) in lockstep with SDK emitters.
 */
function deriveExpectedMemo(
	op: ParsedOperation,
	requirement: Extract<PaymentRequirement, { kind: "fixed" | "scaled" }>,
): string {
	const key = requirement.memoKey;
	let naturalKey: string;
	if (key === "collectionId") {
		naturalKey = typeof op.data.id === "string" ? op.data.id : "";
	} else if (key === "nftId") {
		naturalKey = typeof op.data.nftId === "string" ? op.data.nftId : "";
	} else if (key === "seedId") {
		naturalKey = typeof op.data.seedId === "string" ? op.data.seedId : "";
	} else {
		// opDigest — reserved fallback; not used by any current action.
		naturalKey = op.operationId;
	}
	if (!naturalKey) {
		throw new Error(
			`Cannot derive expected fee memo: payload missing '${key}' for ${op.action}`,
		);
	}
	return `NFTLox ${requirement.memoTag}:${naturalKey}`;
}

// Typed as Record<ProtocolAction, Handler> (finite union key, not index signature):
// - TypeScript enforces at compile time that every ProtocolAction has a handler.
// - Adding a new action to ALL_ACTIONS without registering a handler here is a compile error.
// - noUncheckedIndexedAccess does NOT add | undefined for mapped types, so lookups
//   with a ProtocolAction key are guaranteed non-optional — no runtime !handler guard needed.
const handlers: Record<ProtocolAction, Handler> = {
	// Core
	[ACTION_CREATE_COLLECTION]: handleCreateCollection,
	[ACTION_MINT]: handleMint,
	[ACTION_BULK_DISTRIBUTE]: handleBulkDistribute,
	[ACTION_TRANSFER]: handleTransfer,
	[ACTION_SET_DATA]: handleSetData,
	[ACTION_EXTEND_SCHEMA]: handleExtendSchema,
	[ACTION_ARCHIVE_COLLECTION]: handleArchiveCollection,
	[ACTION_NODE_REGISTER]: handleNodeRegister,
	[ACTION_NODE_HEARTBEAT]: handleNodeHeartbeat,

	// Marketplace
	[ACTION_LIST]: handleList,
	[ACTION_UNLIST]: handleUnlist,
	[ACTION_BUY]: handleBuy,

	// Allowances
	[ACTION_NFT_APPROVE]: handleNftApprove,
	[ACTION_NFT_APPROVE_ALL]: handleNftApproveAll,
	[ACTION_NFT_TRANSFER_FROM]: handleNftTransferFrom,

	// Data Operators
	[ACTION_DATA_OPERATOR_APPROVE]: handleDataOperatorApprove,
	[ACTION_SET_DATA_FROM]: handleSetDataFrom,

	// Lending
	[ACTION_NFT_LEND]: handleNftLend,
	[ACTION_NFT_RETURN]: handleNftReturn,
};

/**
 * Routes an operation to its handler. This function is INFALLIBLE — it never throws.
 * If a handler fails, the error is recorded in invalid_operations and processing continues.
 * This guarantees that a single bad operation can never stall the sync loop or cause block gaps.
 *
 * Returns true if the handler executed successfully, false otherwise.
 * Used by the sync engine's circuit breaker to detect systematic failures.
 */
export async function routeOperation(op: ParsedOperation, txn: Queryable): Promise<boolean> {
	try {
		// Idempotency gate: skip handler dispatch if this operation_id has already been
		// confirmed. Protects against crash-replay drift in denormalized counters when
		// `synchronous_commit=OFF` (used during massive sync) lets a committed tx be lost
		// and the sync engine re-processes the same range.
		if (await isOperationConfirmed(op.operationId, txn)) {
			return true;
		}

		// op.action: ProtocolAction — validated by the parser (isProtocolAction guard).
		// handlers: Record<ProtocolAction, Handler> — compile-time exhaustiveness enforced.
		// Lookup is non-optional: if this compiles, the handler exists.
		const handler = handlers[op.action];

		const authMismatchReason = getAuthMismatchReason(op.action, op.authLevel);
		if (authMismatchReason) {
			await insertInvalidOperation({
				blockNum: op.blockNum,
				txId: op.txId,
				operationId: op.operationId,
				signer: op.signer,
				action: op.action,
				reason: authMismatchReason,
				rawPayload: op.data,
			}, txn);
			return false;
		}

		try {
			const buffer = getStateRootBuffer(txn);
			const bufferSnap = buffer.checkpoint();
			const txHandle = getTxSavepointHandle(txn);
			// Snapshot the shared TransferPool.consumed BEFORE the handler runs —
			// if the savepoint rolls back, any indices claimed by the handler
			// (via verifyTransfers) must be reverted so the next op in the same
			// Hive tx sees an unchanged pool.
			const consumedSnap: Set<number> | null = op.transferPool
				? new Set(op.transferPool.consumed)
				: null;

			// Pre-handler payment dispatch. `none` / `fixed` / `scaled` run here;
			// `split` (buy) stays in the handler — it needs a DB-locked NFT row.
			// The router owns consumed-set mutation so a failed handler can't
			// leak indices. We if/else on `requirement.kind` so TS narrows each
			// branch to the correct Validator<K> input — no widening casts.
			const requirement = getPaymentRequirement(op.action);
			let preMatch: PaymentMatch | null = null;
			if (requirement.kind === "fixed") {
				const expectedMemo = deriveExpectedMemo(op, requirement);
				preMatch = PAYMENT_VALIDATORS.fixed(op, requirement, {
					targetAccount: config.hiveAccount,
					expectedMemo,
				});
			} else if (requirement.kind === "scaled") {
				const expectedMemo = deriveExpectedMemo(op, requirement);
				preMatch = PAYMENT_VALIDATORS.scaled(op, requirement, {
					targetAccount: config.hiveAccount,
					expectedMemo,
				});
			} else if (requirement.kind === "none") {
				preMatch = PAYMENT_VALIDATORS.none(op, requirement, {
					targetAccount: config.hiveAccount,
				});
			}
			// "split" is deferred to the handler (verifyTransfers in handleBuy).
			if (preMatch) op.payment = preMatch;

			const nftIds = await txHandle
				.savepoint((spSql) => {
					const scoped = attachScope(spSql as unknown as Queryable, {
						buffer,
						handle: txHandle,
					});
					return handler(op, scoped);
				})
				.catch((err) => {
					// postgres.js already executed ROLLBACK TO SAVEPOINT automatically.
					// Revert the in-memory buffer AND the consumed-indices set to
					// match the reverted database state.
					buffer.rollbackTo(bufferSnap);
					if (consumedSnap && op.transferPool) {
						op.transferPool.consumed.clear();
						for (const i of consumedSnap) op.transferPool.consumed.add(i);
					}
					throw err;
				});

			// Savepoint committed: mark pre-validated transfers as consumed.
			// Split handlers mutate `consumed` inside verifyTransfers, so we
			// only touch it for fixed/scaled matches.
			if (preMatch && (preMatch.kind === "fixed" || preMatch.kind === "scaled") && op.transferPool) {
				for (const idx of preMatch.consumedIndices) op.transferPool.consumed.add(idx);
			}

			await insertConfirmedOperation({
				operationId: op.operationId,
				txId: op.txId,
				blockNum: op.blockNum,
				signer: op.signer,
				action: op.action,
				nftIds: confirmedOperationNftIds(op.action, nftIds),
				createdAt: op.timestamp,
			}, txn);
			return true;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			log.warn(`Handler failed: ${op.action}`, { blockNum: op.blockNum, txId: op.txId, reason });

			await insertInvalidOperation({
				blockNum: op.blockNum,
				txId: op.txId,
				operationId: op.operationId,
				signer: op.signer,
				action: op.action,
				reason,
				rawPayload: op.data,
			}, txn);

			// Flag failed buy operations that had HIVE transfers as orphaned buys.
			// These represent cases where funds moved on-chain but NFT ownership was NOT updated.
			const isBuyAction = op.action === ACTION_BUY;
			const transfers = op.pairedTransfers;
			const firstTransfer = transfers?.[0];
			if (isBuyAction && transfers && transfers.length > 0 && firstTransfer) {
				log.error("ORPHANED BUY DETECTED — funds transferred but ownership NOT updated", {
					blockNum: op.blockNum,
					txId: op.txId,
					operationId: op.operationId,
					transfers,
				});
				await insertOrphanedBuy({
					blockNum: op.blockNum,
					txId: op.txId,
					operationId: op.operationId,
					buyer: firstTransfer.from,
					nftId: typeof op.data.nftId === "string" ? op.data.nftId : null,
					reason,
					transfers,
				}, txn);
			}
			return false;
		}
	} catch (fatal) {
		// Last-resort catch: even insertInvalidOperation/insertOrphanedBuy failed.
		// Log and continue — never let a single operation abort the entire batch.
		log.error("FATAL: routeOperation could not record error — operation skipped silently", {
			blockNum: op.blockNum,
			txId: op.txId,
			action: op.action,
			error: fatal instanceof Error ? fatal.message : String(fatal),
		});
		return false;
	}
}
