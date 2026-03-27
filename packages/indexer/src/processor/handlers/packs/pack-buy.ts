import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getPackForProcessing,
	upsertPackBalance,
	incrementPackSupply,
	updatePackStatus,
} from "@/db/queries/packs.ts";
import { requireString, requireNumber } from "@/utils/validation.ts";

export async function handlePackBuy(op: ParsedOperation, txn: Queryable): Promise<void> {
	const packId = requireString(op.data.packId, "packId");
	const quantity = requireNumber(op.data.quantity, "quantity");

	if (quantity < 1) throw new Error("Quantity must be positive");

	const pack = await getPackForProcessing(packId, txn);
	if (!pack) throw new Error(`Pack not found: ${packId}`);
	if (pack.status !== "active") throw new Error(`Pack is not active: ${pack.status}`);

	// Check supply
	if (pack.max_supply > 0) {
		const remaining = pack.max_supply - pack.current_supply;
		if (quantity > remaining) {
			throw new Error(`Insufficient supply: ${remaining} remaining`);
		}
	}

	// Payment verification for paid packs
	if (pack.price_amount !== null) {
		if (!op.pairedTransfers || op.pairedTransfers.length === 0) {
			throw new Error("Payment transfer required for paid pack");
		}

		const pricePerUnit = parseFloat(pack.price_amount);
		if (Number.isNaN(pricePerUnit) || pricePerUnit <= 0 || !Number.isFinite(pricePerUnit)) {
			throw new Error(`Pack has invalid price: ${pack.price_amount}`);
		}

		const expectedTotal = pricePerUnit * quantity;

		const payment = op.pairedTransfers.find(t =>
			t.from === op.signer &&
			t.to === pack.creator &&
			t.currency === pack.price_currency &&
			t.amount >= expectedTotal
		);

		if (!payment) {
			throw new Error(
				`Invalid payment: expected >= ${expectedTotal} ${pack.price_currency} from @${op.signer} to @${pack.creator}`,
			);
		}
	}

	await upsertPackBalance(op.signer, packId, quantity, txn);
	await incrementPackSupply(packId, quantity, txn);

	if (pack.max_supply > 0 && (pack.current_supply + quantity) >= pack.max_supply) {
		await updatePackStatus(packId, "depleted", txn);
	}
}
