import { config } from "../config.ts";
import {
	PROTOCOL_ID,
	MIN_PROTOCOL_VERSION,
	ALL_ACTIONS,
	type ProtocolAction,
} from "../protocol.ts";
import type { BlockData } from "./hive-client.ts";

export interface ParsedOperation {
	blockNum: number;
	timestamp: string;
	txId: string;
	signer: string;
	action: ProtocolAction;
	version: string;
	data: Record<string, unknown>;
	pairedTransfer?: {
		from: string;
		to: string;
		amount: string;
		memo: string;
	};
}

const protocolId = config.protocolId ?? PROTOCOL_ID;

// ─── Type Guards ────────────────────────────────────

function isNonNullObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolAction(value: string): value is ProtocolAction {
	return (ALL_ACTIONS as readonly string[]).includes(value);
}

interface TransferOperationValue {
	readonly from: string;
	readonly to: string;
	readonly amount: { readonly amount: string; readonly nai: string; readonly precision: number };
	readonly memo: string;
}

function isTransferValue(value: unknown): value is TransferOperationValue {
	if (!isNonNullObject(value)) return false;
	return (
		typeof value.from === "string" &&
		typeof value.to === "string" &&
		typeof value.memo === "string" &&
		isNonNullObject(value.amount) &&
		typeof value.amount.amount === "string"
	);
}

interface CustomJsonOperationValue {
	readonly required_auths: readonly string[];
	readonly required_posting_auths: readonly string[];
	readonly id: string;
	readonly json: string;
}

function isCustomJsonValue(value: unknown): value is CustomJsonOperationValue {
	if (!isNonNullObject(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.json === "string" &&
		Array.isArray(value.required_auths) &&
		Array.isArray(value.required_posting_auths)
	);
}

// ─── Payload Validation ─────────────────────────────

function compareVersions(a: string, b: string): number {
	const partsA = a.split(".").map(Number);
	const partsB = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const numA = partsA[i] ?? 0;
		const numB = partsB[i] ?? 0;
		if (numA < numB) return -1;
		if (numA > numB) return 1;
	}
	return 0;
}

function isValidPayload(payload: unknown): payload is {
	protocol: string;
	version: string;
	action: ProtocolAction;
	data: Record<string, unknown>;
} {
	if (!isNonNullObject(payload)) return false;

	if (payload.protocol !== protocolId) return false;
	if (typeof payload.version !== "string") return false;
	if (compareVersions(payload.version, MIN_PROTOCOL_VERSION) < 0) return false;
	if (typeof payload.action !== "string") return false;
	if (!isProtocolAction(payload.action)) return false;
	if (!isNonNullObject(payload.data)) return false;

	return true;
}

// ─── Block Parser ───────────────────────────────────

export function parseBlockOperations(block: BlockData): ParsedOperation[] {
	const ops: ParsedOperation[] = [];

	for (const tx of block.transactions) {
		let pairedTransfer: ParsedOperation["pairedTransfer"] | undefined;

		// First pass: find nftlox transfer in this tx (for atomic pairs)
		for (const op of tx.operations) {
			if (op.type === "transfer_operation" && isTransferValue(op.value)) {
				const memo = op.value.memo;
				if (memo.startsWith("nftlox:")) {
					const amount = op.value.amount;
					const precision = amount.precision ?? 3;
					const numericAmount = Number(amount.amount) / Math.pow(10, precision);
					const nai = amount.nai === "@@000000013" ? "HBD" : "HIVE";
					pairedTransfer = {
						from: op.value.from,
						to: op.value.to,
						amount: `${numericAmount.toFixed(precision)} ${nai}`,
						memo,
					};
				}
			}
		}

		// Second pass: find custom_json with our protocol ID
		for (const op of tx.operations) {
			if (op.type !== "custom_json_operation") continue;
			if (!isCustomJsonValue(op.value)) continue;
			if (op.value.id !== protocolId) continue;

			let payload: unknown;
			try {
				payload = JSON.parse(op.value.json);
			} catch {
				continue;
			}

			if (!isValidPayload(payload)) continue;

			const signer =
				op.value.required_auths[0] ??
				op.value.required_posting_auths[0] ??
				"unknown";

			ops.push({
				blockNum: block.blockNum,
				timestamp: block.timestamp,
				txId: tx.txId,
				signer,
				action: payload.action,
				version: payload.version,
				data: payload.data,
				pairedTransfer,
			});
		}
	}

	return ops;
}
