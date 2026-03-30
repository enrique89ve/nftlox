import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getPackForProcessing,
	upsertPackBalance,
	incrementPackSupply,
	updatePackStatus,
} from "@/db/queries/packs.ts";
import { requireString, requireNumber } from "@/utils/validation.ts";
import { validatePackPayment } from "@/utils/nft-rules.ts";
import { MAX_PACK_OPEN_BATCH } from "nftlox-sdk";

export async function handlePackBuy(op: ParsedOperation, txn: Queryable): Promise<void> {
	const packId = requireString(op.data.packId, "packId");
	const quantity = requireNumber(op.data.quantity, "quantity");

	if (quantity < 1) throw new Error("Quantity must be positive");
	if (quantity > MAX_PACK_OPEN_BATCH) {
		throw new Error(`Cannot buy more than ${MAX_PACK_OPEN_BATCH} packs at once, got ${quantity}`);
	}

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

		validatePackPayment({
			transfers: op.pairedTransfers,
			buyer: op.signer,
			creator: pack.creator,
			pricePerUnit: parseFloat(pack.price_amount),
			currency: pack.price_currency ?? "",
			quantity,
		});
	}

	await upsertPackBalance(op.signer, packId, quantity, txn);
	await incrementPackSupply(packId, quantity, txn);

	if (pack.max_supply > 0 && (pack.current_supply + quantity) >= pack.max_supply) {
		await updatePackStatus(packId, "depleted", txn);
	}
}
