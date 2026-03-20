import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getPackForProcessing, insertPackHistoryEvent } from "@/db/queries/packs.ts";
import { upsertPackAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireNumber, requireBoolean } from "@/utils/validation.ts";

export async function handlePackApprove(op: ParsedOperation, txn: Queryable): Promise<void> {
	const spender = requireString(op.data.spender, "spender");
	const packId = requireString(op.data.packId, "packId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw new Error("Cannot approve yourself");

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);

	const quantity = approved ? requireNumber(op.data.quantity, "quantity") : 0;
	if (approved && quantity < 1) throw new Error("Quantity must be positive when approving");

	await upsertPackAllowance(
		op.signer, spender, packId, quantity,
		op.blockNum, op.txId, txn,
	);

	await insertPackHistoryEvent({
		packId,
		collectionId: pack.collection_id,
		eventType: "pack_approve",
		blockNum: op.blockNum,
		txId: op.txId,
		timestamp: op.timestamp,
		fromAccount: op.signer,
		toAccount: approved ? spender : null,
		quantity: approved ? quantity : null,
		priceAmount: null,
		priceCurrency: null,
		payload: op.data,
	}, txn);
}
