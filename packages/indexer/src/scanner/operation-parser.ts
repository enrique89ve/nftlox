import { config } from "@/config.ts";
import {
	MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	ALL_ACTIONS,
	type ProtocolAction,
} from "@/protocol/index.ts";
import { createLogger } from "@/utils/logger.ts";
import type { HafAHOperation } from "./hive-client.ts";

const log = createLogger("parser");

export type AuthLevel = "active" | "posting";

export interface TransferDetail {
	from: string;
	to: string;
	amount: number;
	currency: string;
	memo: string;
}

/**
 * Pool of transfers shared across operations within the same Hive transaction.
 * The `consumed` set tracks indices already claimed by prior ops, preventing
 * a single transfer from satisfying multiple payment validations.
 */
export interface TransferPool {
	readonly transfers: ReadonlyArray<TransferDetail>;
	readonly consumed: Set<number>;
}

export interface ParsedOperation {
	blockNum: number;
	timestamp: string;
	txId: string;
	operationId: string;
	signer: string;
	authLevel: AuthLevel;
	action: ProtocolAction;
	version: string;
	data: Record<string, unknown>;
	pairedTransfers?: Array<TransferDetail>;
	transferPool?: TransferPool;
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

// ─── Format Validators ──────────────────────────────

/** Hive transaction ID: first 20 bytes of SHA256 = 40 hex chars */
const TX_ID_REGEX = /^[0-9a-f]{40}$/;

function isValidTxId(txId: string): boolean {
	return TX_ID_REGEX.test(txId);
}

/** HafAH operation_id is a bigint (numeric string or number) */
function isValidOperationId(opId: unknown): boolean {
	if (typeof opId === "number") return Number.isInteger(opId) && opId >= 0;
	if (typeof opId === "string") return /^\d+$/.test(opId);
	return false;
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

// ─── Rejected Operation ───────────────────────────

export interface RejectedOperation {
	blockNum: number;
	txId: string;
	operationId: string;
	signer: string | null;
	reason: string;
	rawPayload: unknown;
}

export interface ParseResult {
	ops: ParsedOperation[];
	rejected: RejectedOperation[];
}

// ─── HafAH Parser ──────────────────────────────────

/**
 * Parse HafAH operations directly — much faster than parsing full blocks.
 * HafAH already filters to custom_json (op_type=18), we just filter by protocol ID.
 *
 * Returns both valid ops and rejected ops (malformed payloads that match our
 * protocol ID but fail validation). Rejected ops should be recorded in
 * invalid_operations for observability — silently discarding them hides failures.
 *
 * NOTE: Paired transfers are enriched separately by the sync engine via
 * getTransfersInBlock() for actions that require payment verification.
 */
export function parseHafAHOperations(hafOps: HafAHOperation[]): ParseResult {
	const ops: ParsedOperation[] = [];
	const rejected: RejectedOperation[] = [];

	for (const hafOp of hafOps) {
		const value = hafOp.op.value;
		if (value.id !== protocolId) continue;

		const signer = value.required_auths[0] ?? value.required_posting_auths[0] ?? null;

		// Validate txId format (40 hex chars = first 20 bytes of SHA256)
		if (!isValidTxId(hafOp.trx_id)) {
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: hafOp.operation_id,
				signer,
				reason: `Invalid transaction ID format: ${hafOp.trx_id}`,
				rawPayload: value.json,
			});
			continue;
		}

		// Validate operationId format (positive integer from HafAH)
		if (!isValidOperationId(hafOp.operation_id)) {
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: String(hafOp.operation_id),
				signer,
				reason: `Invalid operation ID format: ${hafOp.operation_id}`,
				rawPayload: value.json,
			});
			continue;
		}

		let payload: unknown;
		try {
			payload = JSON.parse(value.json);
		} catch {
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: hafOp.operation_id,
				signer,
				reason: "Malformed JSON payload",
				rawPayload: value.json,
			});
			continue;
		}

		if (!isValidPayload(payload)) {
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: hafOp.operation_id,
				signer,
				reason: describePayloadRejection(payload),
				rawPayload: payload,
			});
			continue;
		}

		// Warn about operations from SDK versions newer than this indexer
		if (compareVersions(payload.version, PROTOCOL_VERSION) > 0) {
			log.warn("Operation version ahead of indexer", {
				version: payload.version,
				indexerVersion: PROTOCOL_VERSION,
				txId: hafOp.trx_id,
			});
		}

		const hasActiveAuth = value.required_auths.length > 0;
		const authLevel: AuthLevel = hasActiveAuth ? "active" : "posting";

		// Reject operations without a valid signer — cannot authorize anything
		if (!signer) {
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: hafOp.operation_id,
				signer: null,
				reason: "No valid signer (empty required_auths and required_posting_auths)",
				rawPayload: payload,
			});
			continue;
		}

		ops.push({
			blockNum: hafOp.block,
			timestamp: hafOp.timestamp,
			txId: hafOp.trx_id,
			operationId: hafOp.operation_id,
			signer,
			authLevel,
			action: payload.action,
			version: payload.version,
			data: payload.data,
		});
	}

	return { ops, rejected };
}

function describePayloadRejection(payload: unknown): string {
	if (!isNonNullObject(payload)) return "Payload is not a valid object";
	if (payload.protocol !== protocolId) return `Wrong protocol: ${String(payload.protocol)}`;
	if (typeof payload.version !== "string") return "Missing or invalid version";
	if (compareVersions(payload.version, MIN_PROTOCOL_VERSION) < 0) {
		return `Version ${payload.version} below minimum ${MIN_PROTOCOL_VERSION}`;
	}
	if (typeof payload.action !== "string") return "Missing or invalid action field";
	if (!isProtocolAction(payload.action)) return `Unknown action: ${payload.action}`;
	if (!isNonNullObject(payload.data)) return "Missing or invalid data field";
	return "Invalid payload structure";
}
