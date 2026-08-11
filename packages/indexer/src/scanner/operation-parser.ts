import { config } from "@/config.ts";
import {
	MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	TX_ID_REGEX,
	compareVersions,
	isProtocolAction,
	parseProtocolVersion,
	type AuthLevel,
	type ProtocolAction,
} from "@/protocol/index.ts";
import { createLogger } from "@/utils/logger.ts";
import { prototypePollutionReviver } from "@/utils/json-safety.ts";
import { normalizeHiveTimestampToUtc } from "@/utils/hive-timestamp.ts";
import type { HafAHOperation, TransferDetail } from "./hive-client.ts";
import type { PaymentMatch } from "@/processor/payment.ts";

const log = createLogger("parser");

export type { AuthLevel } from "@/protocol/index.ts";

// Re-exported so consumers that already speak the parser layer
// (`TransferPool`, `ParsedOperation`) don't need to reach into hive-client.
export type { TransferDetail } from "./hive-client.ts";

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
	/**
	 * Populated by action-router pre-dispatch when the action's
	 * PaymentRequirement resolves to `none` / `fixed` / `scaled`. Handlers
	 * read `op.payment.payer` for memo-bound identity. Absent for `split`
	 * (validated inside the handler via verifyTransfers).
	 */
	payment?: PaymentMatch;
}

const protocolId = config.protocolId;

function normalizeHafahTimestampToUtc(raw: unknown): string {
	return normalizeHiveTimestampToUtc(raw, "HAFAH timestamp");
}

// ─── Type Guards ────────────────────────────────────

function isNonNullObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
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

function isValidTxId(txId: string): boolean {
	return TX_ID_REGEX.test(txId);
}

/**
 * HafAH `operation_id` is a Postgres bigint. The wire contract is a numeric
 * string (see `HafAHOperation.operation_id: string`), but some endpoints serialize
 * it as a JSON number. We accept both but reject numbers outside JS's safe-
 * integer range: two distinct bigints above 2^53 - 1 collapse to the same JS
 * Number on parse, which would let the `confirmed_operations` replay gate in
 * `action-router.ts` treat two unrelated operations as the same one and skip
 * the second handler dispatch — silent double-skip is worse than refusing the
 * batch outright.
 */
function isValidOperationId(opId: unknown): boolean {
	if (typeof opId === "number") return Number.isSafeInteger(opId) && opId >= 0;
	if (typeof opId === "string") return /^\d+$/.test(opId);
	return false;
}

// ─── Payload Validation ─────────────────────────────
//
// Version semantics live in `@nftlox/protocol`'s `version` module —
// `parseProtocolVersion` and `compareVersions` are imported above.

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

type ForensicCandidatePayload = Readonly<{
	readonly protocol: string;
	readonly version: string;
	readonly action: ProtocolAction;
}>;

function hasForensicPayloadSignal(payload: unknown): payload is ForensicCandidatePayload {
	if (!isNonNullObject(payload)) return false;
	if (payload.protocol !== protocolId) return false;
	if (typeof payload.version !== "string") return false;
	if (!parseProtocolVersion(payload.version)) return false;
	if (compareVersions(payload.version, MIN_PROTOCOL_VERSION) < 0) return false;
	if (typeof payload.action !== "string") return false;
	if (!isProtocolAction(payload.action)) return false;
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
 * Returns both valid ops and rejected ops. Only protocol-shaped payloads with
 * real forensic signal are rejected; low-signal garbage (empty envelopes,
 * malformed JSON, unknown actions, missing versions) is ignored even if it
 * reuses our custom_json id.
 *
 * NOTE: Paired transfers are enriched separately by the sync engine via
 * getTransfersInBlock() for actions that require payment verification.
 */
export function parseHafAHOperations(hafOps: HafAHOperation[]): ParseResult {
	const ops: ParsedOperation[] = [];
	const rejected: RejectedOperation[] = [];

	for (const hafOp of hafOps) {
		// Defense-in-depth at the parser boundary: drop ops whose block isn't a
		// non-negative integer before any code copies the value into
		// ParsedOperation, the genesis gate (NaN coerces to `false` on `<`), or
		// rejected[] forensics.
		if (!Number.isInteger(hafOp.block) || hafOp.block < 0) continue;

		const rawOperation: unknown = hafOp.op;
		if (!isNonNullObject(rawOperation)) continue;
		const rawValue: unknown = rawOperation.value;
		if (!isCustomJsonValue(rawValue)) {
			const rawId = isNonNullObject(rawValue) ? rawValue.id : null;
			if (rawId !== protocolId) continue;
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
				operationId: String(hafOp.operation_id),
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
			continue;
		}

		if (!isValidPayload(payload)) {
			if (!hasForensicPayloadSignal(payload)) continue;
			rejected.push({
				blockNum: hafOp.block,
				txId: hafOp.trx_id,
				operationId: String(hafOp.operation_id),
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
				operationId: String(hafOp.operation_id),
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
				operationId: String(hafOp.operation_id),
				signer: auth.signer,
				reason: `Operation at block ${hafOp.block} predates genesis ${config.genesisBlock}`,
				rawPayload: payload,
			});
			continue;
		}

		const timestamp = normalizeHafahTimestampToUtc(hafOp.timestamp);

		// String-coerce defense-in-depth: HafAHOperation declares operation_id as
		// string, but the JSON cast in hive-client.ts is unchecked. If an endpoint
		// ever emits a JSON number, isValidOperationId guarded it to the safe-
		// integer range above; coercing here guarantees downstream BD reads and
		// the `confirmed_operations` replay gate see a single canonical type.
		ops.push({
			blockNum: hafOp.block,
			timestamp,
			txId: hafOp.trx_id,
			operationId: String(hafOp.operation_id),
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
