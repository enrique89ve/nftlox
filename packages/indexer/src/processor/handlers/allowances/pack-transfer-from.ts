import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getPackForProcessing,
	upsertPackBalance,
	getPackBalance,
} from "@/db/queries/packs.ts";
import { getPackAllowance, deductPackAllowance } from "@/db/queries/allowances.ts";
import { requireString, requirePositiveInt, requireUsername } from "@/utils/validation.ts";

export async function handlePackTransferFrom(op: ParsedOperation, txn: Queryable): Promise<void> {
	const from = requireUsername(op.data.from, "from");
	const to = requireUsername(op.data.to, "to");
	const packId = requireString(op.data.packId, "packId");
	const quantity = requirePositiveInt(op.data.quantity, "quantity");
	if (from === to) throw new Error("Cannot transfer to yourself");

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);

	// Verify spender has sufficient allowance
	const allowance = await getPackAllowance(from, op.signer, packId, txn);
	if (allowance < quantity) {
		throw new Error(
			`Insufficient allowance: has ${allowance}, needs ${quantity}`,
		);
	}

	// Verify owner has sufficient balance
	const ownerBalance = await getPackBalance(from, packId, txn);
	if (ownerBalance < quantity) {
		throw new Error(
			`Insufficient pack balance: has ${ownerBalance}, needs ${quantity}`,
		);
	}

	// Deduct allowance first (prevents double-spend)
	await deductPackAllowance(from, op.signer, packId, quantity, txn);

	// Execute transfer
	await upsertPackBalance(from, packId, -quantity, txn);
	await upsertPackBalance(to, packId, quantity, txn);
}
