import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { createLogger } from "@/utils/logger.ts";
import { insertInvalidOperation } from "@/db/queries/sync.ts";

// Core
import { handleCreateCollection } from "./handlers/core/create-collection.ts";
import { handleMint } from "./handlers/core/mint.ts";
import { handleDistribute } from "./handlers/core/distribute.ts";
import { handleTransfer } from "./handlers/core/transfer.ts";
import { handleBurn } from "./handlers/core/burn.ts";
import { handleReplicate } from "./handlers/core/replicate.ts";
import { handleSetData } from "./handlers/core/set-data.ts";

// Marketplace
import { handleList } from "./handlers/marketplace/list.ts";
import { handleUnlist } from "./handlers/marketplace/unlist.ts";
import { handleBuy } from "./handlers/marketplace/buy.ts";
import { handleOffer } from "./handlers/marketplace/offer.ts";
import { handleAcceptOffer } from "./handlers/marketplace/accept-offer.ts";
import { handleRejectOffer } from "./handlers/marketplace/reject-offer.ts";

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

type Handler = (op: ParsedOperation, txn: Queryable) => Promise<void>;

const handlers: Record<string, Handler> = {
	// Core
	create_collection: handleCreateCollection,
	mint: handleMint,
	distribute: handleDistribute,
	transfer: handleTransfer,
	burn: handleBurn,
	replicate: handleReplicate,
	set_data: handleSetData,

	// Marketplace
	list: handleList,
	unlist: handleUnlist,
	buy: handleBuy,
	offer: handleOffer,
	accept_offer: handleAcceptOffer,
	reject_offer: handleRejectOffer,

	// Packs
	pack_create: handlePackCreate,
	pack_buy: handlePackBuy,
	pack_transfer: handlePackTransfer,
	pack_open: handlePackOpen,

	// Allowances
	nft_approve: handleNftApprove,
	nft_approve_all: handleNftApproveAll,
	nft_transfer_from: handleNftTransferFrom,
	pack_approve: handlePackApprove,
	pack_transfer_from: handlePackTransferFrom,

	// Data Operators
	data_operator_approve: handleDataOperatorApprove,
	set_data_from: handleSetDataFrom,

	// Lending
	nft_lend: handleNftLend,
	nft_return: handleNftReturn,
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
