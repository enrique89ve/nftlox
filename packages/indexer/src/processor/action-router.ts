import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { createLogger } from "@/utils/logger.ts";
import { insertInvalidOperation, insertOrphanedBuy } from "@/db/queries/sync.ts";
import {
	ACTION_BUY,
	ACTION_PACK_BUY,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_BURN,
	ACTION_REPLICATE,
	ACTION_SET_DATA,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_PACK_CREATE,
	ACTION_PACK_TRANSFER,
	ACTION_PACK_OPEN,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_PACK_APPROVE,
	ACTION_PACK_TRANSFER_FROM,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_SET_OWNER_DATA,
	ACTION_EXTEND_SCHEMA,
} from "nftlox-sdk";

// Core
import { handleCreateCollection } from "./handlers/core/create-collection.ts";
import { handleMint } from "./handlers/core/mint.ts";
import { handleBulkDistribute } from "./handlers/core/bulk-distribute.ts";
import { handleTransfer } from "./handlers/core/transfer.ts";
import { handleBurn } from "./handlers/core/burn.ts";
import { handleReplicate } from "./handlers/core/replicate.ts";
import { handleSetData } from "./handlers/core/set-data.ts";
import { handleSetOwnerData } from "./handlers/core/set-owner-data.ts";
import { handleExtendSchema } from "./handlers/core/extend-schema.ts";

// Marketplace
import { handleList } from "./handlers/marketplace/list.ts";
import { handleUnlist } from "./handlers/marketplace/unlist.ts";

import { handleBuy } from "./handlers/marketplace/buy.ts";

// Packs
import { handlePackCreate } from "./handlers/packs/pack-create.ts";
import { handlePackBuy } from "./handlers/packs/pack-buy.ts";
import { handlePackTransfer } from "./handlers/packs/pack-transfer.ts";
import { handlePackOpen } from "./handlers/packs/pack-open.ts";

// Allowances (Approve & TransferFrom)
import { handleNftApprove } from "./handlers/allowances/nft-approve.ts";
import { handleNftApproveAll } from "./handlers/allowances/nft-approve-all.ts";
import { handleNftTransferFrom } from "./handlers/allowances/nft-transfer-from.ts";
import { handlePackApprove } from "./handlers/allowances/pack-approve.ts";
import { handlePackTransferFrom } from "./handlers/allowances/pack-transfer-from.ts";

// Data Operators
import { handleDataOperatorApprove } from "./handlers/allowances/data-operator-approve.ts";
import { handleSetDataFrom } from "./handlers/allowances/set-data-from.ts";

// Lending
import { handleNftLend } from "./handlers/lending/nft-lend.ts";
import { handleNftReturn } from "./handlers/lending/nft-return.ts";

const log = createLogger("router");

// Actions that MUST be signed with active key (required_auths).
// All other actions accept posting key (required_posting_auths).
const ACTIVE_AUTH_ACTIONS = new Set<string>([ACTION_BUY]);

type Handler = (op: ParsedOperation, txn: Queryable) => Promise<void>;

const handlers: Record<string, Handler> = {
	// Core
	[ACTION_CREATE_COLLECTION]: handleCreateCollection,
	[ACTION_MINT]: handleMint,
	[ACTION_BULK_DISTRIBUTE]: handleBulkDistribute,
	[ACTION_TRANSFER]: handleTransfer,
	[ACTION_BURN]: handleBurn,
	[ACTION_REPLICATE]: handleReplicate,
	[ACTION_SET_DATA]: handleSetData,
	[ACTION_SET_OWNER_DATA]: handleSetOwnerData,
	[ACTION_EXTEND_SCHEMA]: handleExtendSchema,

	// Marketplace
	[ACTION_LIST]: handleList,
	[ACTION_UNLIST]: handleUnlist,
	[ACTION_BUY]: handleBuy,

	// Packs
	[ACTION_PACK_CREATE]: handlePackCreate,
	[ACTION_PACK_BUY]: handlePackBuy,
	[ACTION_PACK_TRANSFER]: handlePackTransfer,
	[ACTION_PACK_OPEN]: handlePackOpen,

	// Allowances
	[ACTION_NFT_APPROVE]: handleNftApprove,
	[ACTION_NFT_APPROVE_ALL]: handleNftApproveAll,
	[ACTION_NFT_TRANSFER_FROM]: handleNftTransferFrom,
	[ACTION_PACK_APPROVE]: handlePackApprove,
	[ACTION_PACK_TRANSFER_FROM]: handlePackTransferFrom,

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
 * Pattern inspired by nft-tracker's `process_action` EXCEPTION WHEN OTHERS handler.
 */
export async function routeOperation(op: ParsedOperation, txn: Queryable): Promise<void> {
	try {
		const handler = handlers[op.action];

		if (!handler) {
			await insertInvalidOperation({
				blockNum: op.blockNum,
				txId: op.txId,
				signer: op.signer,
				action: op.action,
				reason: `Unknown action: ${op.action}`,
				rawPayload: op.data,
			}, txn);
			return;
		}

		// Enforce canonical auth level before dispatching
		if (ACTIVE_AUTH_ACTIONS.has(op.action) && op.authLevel !== "active") {
			await insertInvalidOperation({
				blockNum: op.blockNum,
				txId: op.txId,
				signer: op.signer,
				action: op.action,
				reason: `Action '${op.action}' requires active key authority, got posting`,
				rawPayload: op.data,
			}, txn);
			return;
		}

		try {
			await handler(op, txn);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			log.warn(`Handler failed: ${op.action}`, { blockNum: op.blockNum, txId: op.txId, reason });

			await insertInvalidOperation({
				blockNum: op.blockNum,
				txId: op.txId,
				signer: op.signer,
				action: op.action,
				reason,
				rawPayload: op.data,
			}, txn);

			// Flag failed buy/pack_buy operations that had HIVE transfers as orphaned buys.
			// These represent cases where funds moved on-chain but NFT ownership was NOT updated.
			const isBuyAction = op.action === ACTION_BUY || op.action === ACTION_PACK_BUY;
			const transfers = op.pairedTransfers;
			const firstTransfer = transfers?.[0];
			if (isBuyAction && transfers && transfers.length > 0 && firstTransfer) {
				log.error("ORPHANED BUY DETECTED — funds transferred but ownership NOT updated", {
					blockNum: op.blockNum,
					txId: op.txId,
					transfers,
				});
				await insertOrphanedBuy({
					blockNum: op.blockNum,
					txId: op.txId,
					buyer: firstTransfer.from,
					nftId: typeof op.data.nftId === "string" ? op.data.nftId : null,
					reason,
					transfers,
				}, txn);
			}
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
	}
}
