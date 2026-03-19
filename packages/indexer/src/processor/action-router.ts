import type { Queryable } from "../db/client.ts";

import type { ParsedOperation } from "../scanner/operation-parser.ts";
import { createLogger } from "../utils/logger.ts";
import { insertInvalidOperation } from "../db/queries/sync.ts";

import { handleCreateCollection } from "./handlers/create-collection.ts";
import { handleMint } from "./handlers/mint.ts";
import { handleDistribute } from "./handlers/distribute.ts";
import { handleTransfer } from "./handlers/transfer.ts";
import { handleBurn } from "./handlers/burn.ts";
import { handleList } from "./handlers/list.ts";
import { handleUnlist } from "./handlers/unlist.ts";
import { handleBuy } from "./handlers/buy.ts";
import { handleReplicate } from "./handlers/replicate.ts";
import { handleSetData } from "./handlers/set-data.ts";
import { handleOffer } from "./handlers/offer.ts";
import { handleAcceptOffer } from "./handlers/accept-offer.ts";
import { handleRejectOffer } from "./handlers/reject-offer.ts";

const log = createLogger("router");

type Handler = (op: ParsedOperation, txn: Queryable) => Promise<void>;

const handlers: Record<string, Handler> = {
	create_collection: handleCreateCollection,
	mint: handleMint,
	distribute: handleDistribute,
	transfer: handleTransfer,
	burn: handleBurn,
	list: handleList,
	unlist: handleUnlist,
	buy: handleBuy,
	replicate: handleReplicate,
	set_data: handleSetData,
	offer: handleOffer,
	accept_offer: handleAcceptOffer,
	reject_offer: handleRejectOffer,
};

export async function routeOperation(op: ParsedOperation, txn: Queryable): Promise<void> {
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
	}
}
