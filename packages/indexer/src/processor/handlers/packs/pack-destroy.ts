import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getPackForProcessing,
	getTotalPackBalance,
	deleteAllPackBalances,
	deleteAllPackAllowances,
	destroyPack,
} from "@/db/queries/packs.ts";
import { decrementReservedByPacks } from "@/db/queries/nfts.ts";
import { requireString } from "@/utils/validation.ts";

export async function handlePackDestroy(op: ParsedOperation, txn: Queryable): Promise<void> {
	const packId = requireString(op.data.packId, "packId");

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);

	// Idempotency: already destroyed
	if (pack.status === "destroyed") return;

	if (op.signer !== pack.creator) {
		throw new Error(`Only the creator can destroy pack ${packId}`);
	}

	if (pack.status !== "active" && pack.status !== "depleted") {
		throw new Error(`Cannot destroy pack ${packId} with status '${pack.status}'`);
	}

	// Get total remaining balance across all holders
	const totalBalance = await getTotalPackBalance(packId, txn);

	// Release reserved supply back to seeds
	if (pack.reserved_supply) {
		const reserved = typeof pack.reserved_supply === "string"
			? JSON.parse(pack.reserved_supply as string)
			: pack.reserved_supply;

		for (const [seedId, amount] of Object.entries(reserved)) {
			await decrementReservedByPacks(seedId, amount as number, txn);
		}
	}

	// Clean up balances and allowances
	await deleteAllPackBalances(packId, txn);
	await deleteAllPackAllowances(packId, txn);

	// Mark pack as destroyed with audit fields
	await destroyPack(packId, {
		destroyedAt: op.timestamp,
		destroyedTxId: op.txId,
		destroyedBalance: totalBalance,
	}, txn);
}
