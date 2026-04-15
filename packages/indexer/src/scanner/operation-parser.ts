import { config } from "@/config.ts";
import {
	MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	ALL_ACTIONS,
	type AuthLevel,
	type ProtocolAction,
} from "@/protocol/index.ts";
import { createLogger } from "@/utils/logger.ts";
import type { HafAHOperation } from "./hive-client.ts";

const log = createLogger("parser");

export type { AuthLevel } from "@/protocol/index.ts";

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

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
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
		isStringArray(value.required_auths) &&
		isStringArray(value.required_posting_auths)
	);
}

type CustomJsonAuthParseResult =
	| Readonly<{ ok: true; signer: string; authLevel: AuthLevel }>
	| Readonly<{ ok: false; signer: string | null; reason: string }>;

/**
 * NOTE on Hive multisig interop:
 *
 * HafAH's `required_auths` / `required_posting_auths` list the ACCOUNTS whose
 * authority is required, not the individual keys. A single-account multisig
 * (e.g. `alice` with threshold=2 signed by two keys) surfaces as
 * `required_auths: ["alice"]` — so single-account multisig works transparently
 * here because we only ever see the account name.
 *
 * What IS rejected below is multi-ACCOUNT co-signed custom_json
 * (`required_auths: ["alice", "bob"]`). Every protocol action has exactly one
 * signer role (creator, owner, buyer, operator...) so we have no well-defined
 * routing for an op where two different accounts jointly sign. Accepting it
 * would require schema + handler changes to disambiguate who the "signer" is.
 * If a joint-signing use case (DAO, escrow) ever lands, revisit this.
 */
function parseCustomJsonAuth(value: CustomJsonOperationValue): CustomJsonAuthParseResult {
	const activeAuths = value.required_auths;
	const postingAuths = value.required_posting_auths;
	const signer = activeAuths[0] ?? postingAuths[0] ?? null;

	if (activeAuths.length === 0 && postingAuths.length === 0) {
		return {
			ok: false,
			signer: null,
			reason: "No valid signer (empty required_auths and required_posting_auths)",
		};
	}

	if (activeAuths.length > 0 && postingAuths.length > 0) {
		return {
			ok: false,
			signer,
			reason: "Mixed authority levels: required_auths and required_posting_auths cannot both be non-empty",
		};
	}

	if (activeAuths.length > 1) {
		return {
			ok: false,
			signer,
			reason: `Multi-account co-signed custom_json not supported: ${activeAuths.length} active signers (single-account multisig works; only joint signing by distinct accounts is rejected)`,
		};
	}

	if (postingAuths.length > 1) {
		return {
			ok: false,
			signer,
			reason: `Multi-account co-signed custom_json not supported: ${postingAuths.length} posting signers (single-account multisig works; only joint signing by distinct accounts is rejected)`,
		};
	}

	if (activeAuths.length === 1) {
		const activeSigner = activeAuths[0];
		if (!activeSigner) {
			return { ok: false, signer: null, reason: "Invalid active signer: empty account name" };
		}
		return { ok: true, signer: activeSigner, authLevel: "active" };
	}

	const postingSigner = postingAuths[0];
	if (!postingSigner) {
		return { ok: false, signer: null, reason: "Invalid posting signer: empty account name" };
	}
	return { ok: true, signer: postingSigner, authLevel: "posting" };
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

// ─── Prototype Pollution Guard ──────────────────────

/**
 * `JSON.parse` reviver that drops `__proto__` and `constructor` keys so
 * user-supplied blockchain payloads cannot poison objects downstream.
 *
 * Without this, a payload like `{"data": {"__proto__": {"admin": true}}}`
 * creates the key as an own property today, but any code that later spreads
 * or merges that object with `Object.assign`, structured clone through
 * prototype-aware libraries, or `for..in` loops without `hasOwnProperty`
 * guards can escalate it into actual prototype pollution. Strip at the
 * earliest boundary instead of auditing every consumer.
 */
function prototypePollutionReviver(key: string, value: unknown): unknown {
	if (key === "__proto__" || key === "constructor") return undefined;
	return value;
}

// ─── Payload Validation ─────────────────────────────

type ProtocolVersionParts = readonly [number, number, number];

const PROTOCOL_VERSION_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseProtocolVersion(version: string): ProtocolVersionParts | null {
	const match = PROTOCOL_VERSION_REGEX.exec(version);
	if (!match) return null;

	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (
		!Number.isSafeInteger(major) ||
		!Number.isSafeInteger(minor) ||
		!Number.isSafeInteger(patch)
	) {
		return null;
	}

	return [major, minor, patch];
}

function compareVersions(a: string, b: string): number {
	const partsA = parseProtocolVersion(a);
	const partsB = parseProtocolVersion(b);
	if (!partsA || !partsB) {
		throw new Error(`Invalid protocol version comparison: '${a}' vs '${b}'`);
	}
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
	if (!parseProtocolVersion(payload.version)) return false;
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
		const rawValue: unknown = hafOp.op.value;
		if (!isCustomJsonValue(rawValue)) {
			const rawId = isNonNullObject(rawValue) ? rawValue.id : null;
			if (rawId !== protocolId) continue;
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: String(hafOp.operation_id),
				signer: null,
				reason: "Malformed custom_json operation value",
				rawPayload: rawValue,
			});
			continue;
		}

		const value = rawValue;
		if (value.id !== protocolId) continue;

		const auth = parseCustomJsonAuth(value);
		const signer = auth.signer;

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
			payload = JSON.parse(value.json, prototypePollutionReviver);
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

		// Reject malformed or ambiguous protocol authority before routing.
		if (!auth.ok) {
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: hafOp.operation_id,
				signer: auth.signer,
				reason: auth.reason,
				rawPayload: payload,
			});
			continue;
		}

		// Defensive: a well-formed HafAH paginator scoped past genesis should never
		// emit pre-genesis ops. If one slips through (upstream bug, misconfigured
		// scan window, replayed stale data) reject it rather than let it mutate
		// state — pre-genesis activity is out of protocol scope by definition.
		// Placed last so format / auth issues surface with their specific reason.
		if (hafOp.block < config.genesisBlock) {
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: hafOp.operation_id,
				signer: auth.signer,
				reason: `Operation at block ${hafOp.block} predates genesis ${config.genesisBlock}`,
				rawPayload: payload,
			});
			continue;
		}

		ops.push({
			blockNum: hafOp.block,
			timestamp: hafOp.timestamp,
			txId: hafOp.trx_id,
			operationId: hafOp.operation_id,
			signer: auth.signer,
			authLevel: auth.authLevel,
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
	if (!parseProtocolVersion(payload.version)) return `Invalid version format: ${payload.version}`;
	if (compareVersions(payload.version, MIN_PROTOCOL_VERSION) < 0) {
		return `Version ${payload.version} below minimum ${MIN_PROTOCOL_VERSION}`;
	}
	if (typeof payload.action !== "string") return "Missing or invalid action field";
	if (!isProtocolAction(payload.action)) return `Unknown action: ${payload.action}`;
	if (!isNonNullObject(payload.data)) return "Missing or invalid data field";
	return "Invalid payload structure";
}
