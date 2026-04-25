// SPV "Boleto Suizo" - Lightweight Hive L1 Client
// Uses HAFAH REST API with fetch (zero dependencies, browser-compatible)

import {
	MIN_PROTOCOL_VERSION,
	compareVersions,
	computeDataHash,
	isProtocolAction,
	isValidProtocolVersion,
	type ProtocolAction,
} from "@nftlox/protocol";
import { getProtocolId } from "../protocol-state";
import {
	DEFAULT_HIVE_ENDPOINTS,
	DEFAULT_HIVE_TIMEOUT_MS,
} from "./constants";
import type {
	HafahOperationRecord,
	HiveL1Config,
	HafahTransaction,
	L1ParsedOperation,
	ResolveOperationByIdParams,
	ResolvedOperationById,
	ResolveMutableDataParams,
	ResolvedMutableData,
} from "./types";

// ============ ERRORS ============

export class HiveRpcError extends Error {
	public readonly endpoint: string;

	constructor(
		message: string,
		endpoint: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "HiveRpcError";
		this.endpoint = endpoint;
	}
}

// ============ CONFIG ============

export function createDefaultL1Config(): HiveL1Config {
	return {
		endpoints: [...DEFAULT_HIVE_ENDPOINTS],
		timeoutMs: DEFAULT_HIVE_TIMEOUT_MS,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, fieldName: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`HAFAH response has invalid ${fieldName}`);
	}
	return [...value] as string[];
}

// ============ HAFAH REST API ============

/**
 * Fetches a transaction from Hive L1 via HAFAH REST API.
 * Tries each endpoint in order until one succeeds.
 */
export async function fetchTransaction(
	config: HiveL1Config,
	txId: string,
): Promise<HafahTransaction> {
	const errors: Array<{ endpoint: string; error: unknown }> = [];

	for (const endpoint of config.endpoints) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				config.timeoutMs,
			);

			const url = `${endpoint}/hafah-api/transactions/${txId}`;
			const response = await fetch(url, {
				signal: controller.signal,
				headers: { "Accept": "application/json" },
			});
			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const raw = await response.json() as Record<string, unknown>;
			const data = normalizeHafahResponse(raw);
			return data;
		} catch (err) {
			errors.push({ endpoint, error: err });
		}
	}

	const details = errors
		.map((e) => `${e.endpoint}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
		.join("; ");

	throw new HiveRpcError(
		`All endpoints failed for tx ${txId}: ${details}`,
		config.endpoints[0] ?? "unknown",
	);
}

export async function fetchOperationById(
	config: HiveL1Config,
	operationId: string,
): Promise<HafahOperationRecord> {
	const errors: Array<{ endpoint: string; error: unknown }> = [];

	for (const endpoint of config.endpoints) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				config.timeoutMs,
			);

			const url = `${endpoint}/hafah-api/operations/${operationId}`;
			const response = await fetch(url, {
				signal: controller.signal,
				headers: { "Accept": "application/json" },
			});
			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const raw = await response.json() as Record<string, unknown>;
			return normalizeHafahOperation(raw);
		} catch (err) {
			errors.push({ endpoint, error: err });
		}
	}

	const details = errors
		.map((e) => `${e.endpoint}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
		.join("; ");

	throw new HiveRpcError(
		`All endpoints failed for operation ${operationId}: ${details}`,
		config.endpoints[0] ?? "unknown",
	);
}

// ============ JSON-RPC FALLBACK ============

/**
 * Fallback: Hive JSON-RPC 2.0 call (e.g., block_api.get_block).
 */
export async function fetchFromHiveRpc<T>(
	config: HiveL1Config,
	method: string,
	params: Record<string, unknown>,
): Promise<T> {
	const errors: Array<{ endpoint: string; error: unknown }> = [];

	for (const endpoint of config.endpoints) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				config.timeoutMs,
			);

			const response = await fetch(endpoint, {
				method: "POST",
				signal: controller.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					method,
					params,
					id: 1,
				}),
			});
			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const json = await response.json() as Record<string, unknown>;

			if (json.error != null && typeof json.error === "object") {
				const errObj = json.error as Record<string, unknown>;
				throw new Error(`RPC error: ${typeof errObj.message === "string" ? errObj.message : "unknown"}`);
			}

			if (json.result === undefined) {
				throw new Error("RPC response missing 'result' field");
			}

			const result = json.result;
			if (result === null || (typeof result !== "object" && typeof result !== "string" && typeof result !== "number")) {
				throw new Error("RPC response has invalid 'result' type");
			}

			// Caller is responsible for validating the shape of T
			return result as T;
		} catch (err) {
			errors.push({ endpoint, error: err });
		}
	}

	const details = errors
		.map((e) => `${e.endpoint}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
		.join("; ");

	throw new HiveRpcError(
		`All endpoints failed for ${method}: ${details}`,
		config.endpoints[0] ?? "unknown",
	);
}

// ============ RESPONSE NORMALIZER ============

/**
 * Normalizes the HAFAH REST API response to a flat HafahTransaction.
 * HAFAH nests operations inside `transaction_json.operations`,
 * so we extract them to the root-level `operations` field.
 */
function normalizeHafahResponse(raw: Record<string, unknown>): HafahTransaction {
	const txJson = raw.transaction_json as Record<string, unknown> | undefined;
	const operations = txJson?.operations ?? raw.operations;

	if (typeof raw.transaction_id !== "string") {
		throw new Error("HAFAH response missing transaction_id");
	}
	if (typeof raw.block_num !== "number") {
		throw new Error("HAFAH response missing block_num");
	}
	if (!Array.isArray(operations)) {
		throw new Error("HAFAH response missing operations array");
	}

	return {
		transaction_id: raw.transaction_id,
		block_num: raw.block_num,
		transaction_num: typeof raw.transaction_num === "number" ? raw.transaction_num : 0,
		operations: operations as HafahTransaction["operations"],
	};
}

function normalizeHafahOperation(raw: Record<string, unknown>): HafahOperationRecord {
	if (typeof raw.operation_id !== "string" && typeof raw.operation_id !== "number") {
		throw new Error("HAFAH response missing operation_id");
	}
	if (typeof raw.block !== "number") {
		throw new Error("HAFAH response missing block");
	}
	if (typeof raw.trx_id !== "string") {
		throw new Error("HAFAH response missing trx_id");
	}
	if (typeof raw.timestamp !== "string") {
		throw new Error("HAFAH response missing timestamp");
	}
	if (!isRecord(raw.op)) {
		throw new Error("HAFAH response missing op");
	}
	if (typeof raw.op.type !== "string") {
		throw new Error("HAFAH response missing op.type");
	}
	if (!isRecord(raw.op.value)) {
		throw new Error("HAFAH response missing op.value");
	}
	if (typeof raw.op.value.id !== "string") {
		throw new Error("HAFAH response missing op.value.id");
	}
	if (typeof raw.op.value.json !== "string") {
		throw new Error("HAFAH response missing op.value.json");
	}

	return {
		operation_id: String(raw.operation_id),
		block: raw.block,
		trx_id: raw.trx_id,
		timestamp: raw.timestamp,
		virtual_op: raw.virtual_op === true,
		op: {
			type: raw.op.type,
			value: {
				id: raw.op.value.id,
				json: raw.op.value.json,
				required_auths: parseStringArray(raw.op.value.required_auths ?? [], "op.value.required_auths"),
				required_posting_auths: parseStringArray(raw.op.value.required_posting_auths ?? [], "op.value.required_posting_auths"),
			},
		},
	};
}

function parseOperationPayload(
	operationId: string,
	rawJson: string,
): {
	readonly protocol: string;
	readonly version: string;
	readonly action: ProtocolAction;
	readonly data: Record<string, unknown>;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		throw new Error(`Operation ${operationId} contains malformed JSON`);
	}

	if (!isRecord(parsed)) {
		throw new Error(`Operation ${operationId} payload must be an object`);
	}
	if (typeof parsed.protocol !== "string") {
		throw new Error(`Operation ${operationId} payload missing protocol`);
	}
	if (typeof parsed.version !== "string") {
		throw new Error(`Operation ${operationId} payload missing version`);
	}
	if (!isValidProtocolVersion(parsed.version)) {
		throw new Error(`Operation ${operationId} payload has invalid version format: ${parsed.version}`);
	}
	if (compareVersions(parsed.version, MIN_PROTOCOL_VERSION) < 0) {
		throw new Error(
			`Operation ${operationId} payload version ${parsed.version} is below minimum ${MIN_PROTOCOL_VERSION}`,
		);
	}
	if (typeof parsed.action !== "string" || !isProtocolAction(parsed.action)) {
		throw new Error(`Operation ${operationId} payload has invalid action`);
	}
	if (!isRecord(parsed.data)) {
		throw new Error(`Operation ${operationId} payload missing data object`);
	}

	return {
		protocol: parsed.protocol,
		version: parsed.version,
		action: parsed.action,
		data: parsed.data,
	};
}

// ============ OPERATION ID FETCHER ============

const CUSTOM_JSON_OP_TYPE = 18;

/**
 * Fetches ALL HafAH operation_ids for NFTLox custom_json ops in a given tx.
 * Returns them in the same order they appear on-chain, so they can be matched
 * positionally with parseAllNftloxOperations().
 */
export async function fetchOperationIds(
	config: HiveL1Config,
	txId: string,
	blockNum: number,
): Promise<string[]> {
	const protocolId = getProtocolId();
	const errors: Array<{ endpoint: string; error: unknown }> = [];

	for (const endpoint of config.endpoints) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
			const url = `${endpoint}/hafah-api/operations?from-block=${blockNum}&to-block=${blockNum + 1}&operation-types=${CUSTOM_JSON_OP_TYPE}&page-size=1000&operation-begin=-1`;
			const response = await fetch(url, { signal: controller.signal });
			clearTimeout(timeoutId);

			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = await response.json() as Record<string, unknown>;
			const ops = Array.isArray(data.ops) ? data.ops : [];

			const ids: string[] = [];
			for (const op of ops) {
				const entry = op as Record<string, unknown>;
				if (entry.trx_id !== txId) continue;
				const opValue = (entry.op as Record<string, unknown>)?.value as Record<string, unknown> | undefined;
				if (opValue?.id !== protocolId) continue;
				if (typeof entry.operation_id === "string") ids.push(entry.operation_id);
				else if (typeof entry.operation_id === "number") ids.push(String(entry.operation_id));
			}

			// Data result — don't retry on other endpoints (same blockchain data)
			return ids;
		} catch (err) {
			errors.push({ endpoint, error: err });
		}
	}

	const details = errors
		.map((e) => `${e.endpoint}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
		.join("; ");
	throw new HiveRpcError(`All endpoints failed for operationIds: ${details}`, config.endpoints[0] ?? "unknown");
}

/** Backward-compatible: returns the first operation_id. */
export async function fetchOperationId(
	config: HiveL1Config,
	txId: string,
	blockNum: number,
): Promise<string> {
	const ids = await fetchOperationIds(config, txId, blockNum);
	if (ids.length === 0) {
		throw new HiveRpcError(
			`No NFTLox operation found for tx ${txId} in block ${blockNum}`,
			config.endpoints[0] ?? "unknown",
		);
	}
	return ids[0]!;
}

export async function resolveMutableDataFromOperation(
	params: ResolveMutableDataParams,
): Promise<ResolvedMutableData> {
	const resolved = await resolveOperationById({
		l1Config: params.l1Config,
		operationId: params.operationId,
		expectedActions: params.expectedActions,
		protocolId: params.protocolId,
	});

	if (!isRecord(resolved.data.mutableData)) {
		throw new Error(`Operation ${params.operationId} does not contain mutableData`);
	}

	const mutableData = resolved.data.mutableData;
	const hash = await computeDataHash(mutableData);
	if (hash !== params.expectedHash) {
		throw new Error(`Mutable data hash mismatch for operation ${params.operationId}`);
	}

	return {
		operationId: resolved.operationId,
		txId: resolved.txId,
		blockNum: resolved.blockNum,
		timestamp: resolved.timestamp,
		protocolId: resolved.protocolId,
		action: resolved.action,
		signer: resolved.signer,
		mutableData,
		hash,
	};
}

export async function resolveOperationById(
	params: ResolveOperationByIdParams,
): Promise<ResolvedOperationById> {
	const operation = await fetchOperationById(params.l1Config, params.operationId);
	if (operation.op.type !== "custom_json_operation") {
		throw new Error(`Operation ${params.operationId} is not a custom_json_operation`);
	}

	const expectedProtocolId = params.protocolId ?? getProtocolId();
	if (operation.op.value.id !== expectedProtocolId) {
		throw new Error(
			`Operation ${params.operationId} belongs to protocol ${operation.op.value.id}, expected ${expectedProtocolId}`,
		);
	}

	const payload = parseOperationPayload(params.operationId, operation.op.value.json);
	if (payload.protocol !== expectedProtocolId) {
		throw new Error(
			`Operation ${params.operationId} payload protocol ${payload.protocol} does not match ${expectedProtocolId}`,
		);
	}

	if (params.expectedActions && !params.expectedActions.includes(payload.action)) {
		throw new Error(
			`Operation ${params.operationId} action ${payload.action} is not one of ${params.expectedActions.join(", ")}`,
		);
	}

	const signer =
		operation.op.value.required_auths[0]
		?? operation.op.value.required_posting_auths[0]
		?? "";
	if (!signer) {
		throw new Error(`Operation ${params.operationId} does not have a signer`);
	}

	return {
		operationId: operation.operation_id,
		txId: operation.trx_id,
		blockNum: operation.block,
		timestamp: operation.timestamp,
		protocolId: payload.protocol,
		version: payload.version,
		action: payload.action,
		signer,
		data: payload.data,
	};
}

// ============ OPERATION PARSER ============

/**
 * Parses ALL NFTLox custom_json operations from a HAFAH transaction.
 * Returns an array (empty if none found). Each entry includes its index
 * within the NFTLox operations of the tx (not the raw operation index).
 *
 * @param operationIds — HafAH operation_ids fetched via fetchOperationIds(),
 *                        matched positionally with parsed operations.
 */
export function parseAllNftloxOperations(
	tx: HafahTransaction,
	operationIds: ReadonlyArray<string> = [],
): L1ParsedOperation[] {
	const results: L1ParsedOperation[] = [];
	let nftloxIndex = 0;

	for (const op of tx.operations) {
		if (op.type !== "custom_json_operation") continue;

		const value = op.value as {
			id?: string;
			json?: string;
			required_auths?: string[];
			required_posting_auths?: string[];
		};

		if (value.id !== getProtocolId()) continue;

		let parsed: {
			protocol?: string;
			version?: string;
			action?: string;
			data?: Record<string, unknown>;
		};
		try {
			parsed = JSON.parse(value.json ?? "{}") as typeof parsed;
		} catch {
			nftloxIndex++;
			continue;
		}

		if (!parsed.protocol || !parsed.version || !parsed.action || !parsed.data) {
			nftloxIndex++;
			continue;
		}

		const signer =
			value.required_auths?.[0]
			?? value.required_posting_auths?.[0]
			?? "";

		if (!signer) {
			nftloxIndex++;
			continue;
		}

		results.push({
			txId: tx.transaction_id,
			blockNum: tx.block_num,
			signer,
			action: parsed.action,
			data: parsed.data,
			operationId: operationIds[nftloxIndex] ?? "",
		});
		nftloxIndex++;
	}

	return results;
}

/**
 * Backward-compatible: returns the first NFTLox operation in the tx.
 * For multi-op transactions, prefer parseAllNftloxOperations().
 */
export function parseNftloxOperation(
	tx: HafahTransaction,
	operationId = "",
): L1ParsedOperation | null {
	const all = parseAllNftloxOperations(tx, operationId ? [operationId] : []);
	return all[0] ?? null;
}
