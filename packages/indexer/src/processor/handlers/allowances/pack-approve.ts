import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getPackForProcessing, getPackBalance } from "@/db/queries/packs.ts";
import { upsertPackAllowance } from "@/db/queries/allowances.ts";
import { requireString, requirePositiveInt, requireBoolean, requireUsername } from "@/utils/validation.ts";

export async function handlePackApprove(op: ParsedOperation, txn: Queryable): Promise<void> {
	const spender = requireUsername(op.data.spender, "spender");
	const packId = requireString(op.data.packId, "packId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw new Error("Cannot approve yourself");

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);

	const quantity = approved ? requirePositiveInt(op.data.quantity, "quantity") : 0;

	if (approved) {
		const balance = await getPackBalance(op.signer, packId, txn);
		if (balance < quantity) {
			throw new Error(`Insufficient balance: has ${balance}, approving ${quantity} for pack ${packId}`);
		}
	}

	await upsertPackAllowance(
		op.signer, spender, packId, quantity,
		op.blockNum, op.txId, txn,
	);
}
