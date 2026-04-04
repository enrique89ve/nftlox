import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getPackForProcessing,
	upsertPackBalance,
	getPackBalance,
} from "@/db/queries/packs.ts";
import { requireString, requirePositiveInt, requireUsername } from "@/utils/validation.ts";

export async function handlePackTransfer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const packId = requireString(op.data.packId, "packId");
	const to = requireUsername(op.data.to, "to");
	const quantity = requirePositiveInt(op.data.quantity, "quantity");
	if (to === op.signer) throw new Error("Cannot transfer to yourself");

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);
	if (pack.status === "destroyed") throw new Error(`Pack ${packId} has been destroyed`);

	// Pre-check balance before deduction (prevents raw Postgres CHECK violation)
	const senderBalance = await getPackBalance(op.signer, packId, txn);
	if (senderBalance < quantity) {
		throw new Error(
			`Insufficient pack balance: has ${senderBalance}, needs ${quantity}`,
		);
	}

	await upsertPackBalance(op.signer, packId, -quantity, txn);
	// Credit to receiver
	await upsertPackBalance(to, packId, quantity, txn);
}
