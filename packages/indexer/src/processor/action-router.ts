import type { Queryable } from "@/db/client.ts";
import { getStateRootBuffer, getTxSavepointHandle, attachScope } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { createLogger } from "@/utils/logger.ts";
import { assertActiveSettlementNode } from "@/db/queries/nodes.ts";
import { insertInvalidOperation, insertOrphanedBuy, insertConfirmedOperation, isOperationConfirmed } from "@/db/queries/sync.ts";
import {
	ACTION_BUY,
	ACTION_BUY_COMMITMENT,
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
	ACTION_NODE_STATE_CHECKPOINT,
	assertNeverPaymentKind,
	getAuthMismatchReason,
	getPaymentRequirement,
	requiresActiveNodeSigner,
	resolvePaymentRecipient,
	type MemoKey,
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
import { handleNodeStateCheckpoint } from "./handlers/core/node_state_checkpoint.ts";

// Marketplace
import { handleList } from "./handlers/marketplace/list.ts";
import { handleUnlist } from "./handlers/marketplace/unlist.ts";
import { handleBuyCommitment } from "./handlers/marketplace/buy-commitment.ts";

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

export type RouteOperationResult =
	| Readonly<{ readonly kind: "applied" }>
	| Readonly<{ readonly kind: "rejected"; readonly reason: string }>
	| Readonly<{ readonly kind: "fatal"; readonly reason: string }>;

function confirmedOperationNftIds(action: ProtocolAction, nftIds: ReadonlyArray<string>): ReadonlyArray<string> {
	if (action === ACTION_BULK_DISTRIBUTE) return [];
	return nftIds;
}

/**
 * Extractors are keyed by MemoKey — the mapped-record form is the only way
 * to stay compile-time-exhaustive over the union. Adding a new MemoKey to
 * the protocol breaks this object unless a matching extractor is added.
 */
const NATURAL_KEY_EXTRACTORS: Readonly<Record<MemoKey, (op: ParsedOperation) => string>> = {
	collectionId: (op) => (typeof op.data.id === "string" ? op.data.id : ""),
	nftId: (op) => (typeof op.data.nftId === "string" ? op.data.nftId : ""),
	seedId: (op) => (typeof op.data.seedId === "string" ? op.data.seedId : ""),
	// opDigest — reserved fallback; not used by any current action.
	opDigest: (op) => op.operationId,
};

/**
 * Derives the expected fee-transfer memo from the operation payload using
 * the memoKey declared on the PaymentRequirement. Keeps the string format
 * (`NFTLox ${memoTag}:${naturalKey}`) in lockstep with SDK emitters.
 */
function deriveExpectedMemo(
	op: ParsedOperation,
	requirement: Extract<PaymentRequirement, { kind: "fixed" | "scaled" }>,
): string {
	const naturalKey = NATURAL_KEY_EXTRACTORS[requirement.memoKey](op);
	if (!naturalKey) {
		throw new Error(
			`Cannot derive expected fee memo: payload missing '${requirement.memoKey}' for ${op.action}`,
		);
	}
	return `NFTLox ${requirement.memoTag}:${naturalKey}`;
}

/**
 * True when the requirement routes the fee to an account derived from the L1
 * signer. Those operations MUST have `op.signer` registered+active in
 * `l2_nodes` so replays across indexers cannot diverge on who is allowed to
 * settle collection-fee transfers.
 */
function requirementNeedsActiveNodeSigner(requirement: PaymentRequirement): boolean {
	return (
		(requirement.kind === "fixed" || requirement.kind === "scaled") &&
		requirement.recipient === "action:signer"
	);
}

/**
 * Pre-handler payment validation. Exhaustive switch over `requirement.kind` so
 * adding a new PaymentRequirement variant fails the build here instead of
 * silently bypassing validation. `targetAccount` is derived from the
 * declarative `recipient` token via `resolvePaymentRecipient` — identical on
 * every indexer because it reads `op.signer`, not local node config. Returns
 * `null` for `split`, which is deferred to the handler (needs a DB-locked NFT
 * row for price lookup).
 */
function runPreHandlerPaymentValidation(
	op: ParsedOperation,
	requirement: PaymentRequirement,
): PaymentMatch | null {
	switch (requirement.kind) {
		case "none":
			return PAYMENT_VALIDATORS.none(op, requirement, { targetAccount: "" });
		case "fixed":
			return PAYMENT_VALIDATORS.fixed(op, requirement, {
				targetAccount: resolvePaymentRecipient(requirement.recipient, op),
				expectedMemo: deriveExpectedMemo(op, requirement),
			});
		case "scaled":
			return PAYMENT_VALIDATORS.scaled(op, requirement, {
				targetAccount: resolvePaymentRecipient(requirement.recipient, op),
				expectedMemo: deriveExpectedMemo(op, requirement),
			});
		case "split":
			return null;
		default:
			return assertNeverPaymentKind(requirement);
	}
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
	[ACTION_NODE_STATE_CHECKPOINT]: handleNodeStateCheckpoint,

	// Marketplace
	[ACTION_LIST]: handleList,
	[ACTION_UNLIST]: handleUnlist,
	[ACTION_BUY_COMMITMENT]: handleBuyCommitment,
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
 * Returns a discriminated outcome so the sync engine can distinguish
 * consensus-invalid operations ("rejected") from infrastructure failures
 * ("fatal"). Invalid user spam must not trip the sync circuit breaker.
 */
export async function routeOperationDetailed(
	op: ParsedOperation,
	txn: Queryable,
): Promise<RouteOperationResult> {
	try {
		// Idempotency gate: skip handler dispatch if this operation_id has already been
		// confirmed. Protects against ordinary crash-replay drift in denormalized
		// counters when the sync engine re-processes the same range.
		if (await isOperationConfirmed(op.operationId, txn)) {
			return { kind: "applied" };
		}

		// op.action: ProtocolAction — validated by the parser (isProtocolAction guard).
		// handlers: Record<ProtocolAction, Handler> — compile-time exhaustiveness enforced.
		// Lookup is non-optional: if this compiles, the handler exists.
		const handler = handlers[op.action];

		const authCheck = getAuthMismatchReason(op.action, op.authLevel);
		if (!authCheck.ok) {
			await insertInvalidOperation({
				blockNum: op.blockNum,
				txId: op.txId,
				operationId: op.operationId,
				signer: op.signer,
				action: op.action,
				reason: authCheck.message,
				rawPayload: op.data,
			}, txn);
			return { kind: "rejected", reason: authCheck.message };
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
			// `split` (buy) is deferred to the handler — it needs a DB-locked
			// NFT row. The router owns consumed-set mutation so a failed handler
			// can't leak indices. Exhaustive switch inside the helper gives a
			// compile error if a new PaymentRequirement variant is introduced.
			const requirement = getPaymentRequirement(op.action);

			// Consensus gate: the signer MUST be a registered and currently-active
			// settlement node at this block when either
			//   (a) the fee recipient is derived from op.signer (any
			//       `action:signer` requirement — e.g. create_collection), or
			//   (b) the action itself has a node-only role (buy_commitment, buy;
			//       see NODE_SIGNED_ACTIONS in @nftlox/protocol auth.ts).
			// Without this check any Hive account could either "pay itself" the
			// protocol fee or poison a listing's pending_sale slot with a fake
			// commitment hash, breaking the node-network settlement contract.
			// Replay-deterministic — reads only `l2_nodes`, projected from L1
			// node_register / node_heartbeat operations.
			if (
				requirementNeedsActiveNodeSigner(requirement) ||
				requiresActiveNodeSigner(op.action)
			) {
				await assertActiveSettlementNode(op.signer, op.blockNum, txn);
			}

			const preMatch = runPreHandlerPaymentValidation(op, requirement);
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
			return { kind: "applied" };
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
			return { kind: "rejected", reason };
		}
	} catch (fatal) {
		// Last-resort catch: even insertInvalidOperation/insertOrphanedBuy failed.
		// Log and continue — never let a single operation abort the entire batch.
		const reason = fatal instanceof Error ? fatal.message : String(fatal);
		log.error("FATAL: routeOperation could not record error — operation skipped silently", {
			blockNum: op.blockNum,
			txId: op.txId,
			action: op.action,
			error: reason,
		});
		return { kind: "fatal", reason };
	}
}

export async function routeOperation(op: ParsedOperation, txn: Queryable): Promise<boolean> {
	const result = await routeOperationDetailed(op, txn);
	return result.kind === "applied";
}
