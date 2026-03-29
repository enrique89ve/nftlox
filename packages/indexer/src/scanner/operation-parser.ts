import { config } from "@/config.ts";
import {
	MIN_PROTOCOL_VERSION,
	ALL_ACTIONS,
	type ProtocolAction,
} from "@/protocol.ts";
import type { HafAHOperation } from "./hive-client.ts";

export type AuthLevel = "active" | "posting";

export interface ParsedOperation {
	blockNum: number;
	timestamp: string;
	txId: string;
	signer: string;
	authLevel: AuthLevel;
	action: ProtocolAction;
	version: string;
	data: Record<string, unknown>;
	pairedTransfers?: Array<{
		from: string;
		to: string;
		amount: number;
		currency: string;
		memo: string;
	}>;
}

const protocolId = config.protocolId;

// ─── Type Guards ────────────────────────────────────

function isNonNullObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolAction(value: string): value is ProtocolAction {
	return (ALL_ACTIONS as readonly string[]).includes(value);
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

// ─── HafAH Parser ──────────────────────────────────

/**
 * Parse HafAH operations directly — much faster than parsing full blocks.
 * HafAH already filters to custom_json (op_type=18), we just filter by protocol ID.
 *
 * NOTE: Paired transfers are enriched separately by the sync engine via
 * getTransfersInBlock() for actions that require payment verification.
 */
export function parseHafAHOperations(hafOps: HafAHOperation[]): ParsedOperation[] {
	const ops: ParsedOperation[] = [];

	for (const hafOp of hafOps) {
		const value = hafOp.op.value;
		if (value.id !== protocolId) continue;

		let payload: unknown;
		try {
			payload = JSON.parse(value.json);
		} catch {
			continue;
		}

		if (!isValidPayload(payload)) continue;

		const hasActiveAuth = value.required_auths.length > 0;
		const signer = hasActiveAuth
			? value.required_auths[0]
			: value.required_posting_auths[0];
		const authLevel: AuthLevel = hasActiveAuth ? "active" : "posting";

		// Reject operations without a valid signer — cannot authorize anything
		if (!signer) continue;

		ops.push({
			blockNum: hafOp.block,
			timestamp: hafOp.timestamp,
			txId: hafOp.trx_id,
			signer,
			authLevel,
			action: payload.action,
			version: payload.version,
			data: payload.data,
		});
	}

	return ops;
}
