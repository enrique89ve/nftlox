import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getPackForProcessing,
	upsertPackBalance,
	incrementPackSupply,
	insertPackHistoryEvent,
} from "@/db/queries/packs.ts";
import { requireString, requireNumber } from "@/utils/validation.ts";

function parseTransferAmount(amount: string): { value: number; currency: string } {
	const parts = amount.split(" ");
	if (parts.length < 2) {
		throw new Error(`Malformed transfer amount: ${amount}`);
	}
	const value = parseFloat(parts[0]!);
	if (isNaN(value) || value <= 0) {
		throw new Error(`Invalid transfer amount value: ${parts[0]}`);
	}
	return { value, currency: parts[1]! };
}

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
		if (!op.pairedTransfer) {
			throw new Error("Payment transfer required for paid pack");
		}

		const pricePerUnit = parseFloat(pack.price_amount);
		if (isNaN(pricePerUnit)) {
			throw new Error(`Pack has invalid price: ${pack.price_amount}`);
		}

		const expectedTotal = pricePerUnit * quantity;
		const received = parseTransferAmount(op.pairedTransfer.amount);

		if (received.value < expectedTotal) {
			throw new Error(
				`Insufficient payment: expected ${expectedTotal} ${pack.price_currency}, received ${received.value} ${received.currency}`,
			);
		}

		if (op.pairedTransfer.to !== pack.creator) {
			throw new Error(
				`Payment must be sent to pack creator ${pack.creator}, was sent to ${op.pairedTransfer.to}`,
			);
		}
	}

	await upsertPackBalance(op.signer, packId, quantity, txn);
	await incrementPackSupply(packId, quantity, txn);

	await insertPackHistoryEvent({
		packId,
		collectionId: pack.collection_id,
		eventType: "pack_buy",
		blockNum: op.blockNum,
		txId: op.txId,
		timestamp: op.timestamp,
		fromAccount: pack.creator,
		toAccount: op.signer,
		quantity,
		priceAmount: pack.price_amount ? parseFloat(pack.price_amount) * quantity : null,
		priceCurrency: pack.price_currency,
		payload: op.data,
	}, txn);
}
