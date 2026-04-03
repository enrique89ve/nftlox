// SPV "Boleto Suizo" - Lightweight Hive L1 Client
// Uses HAFAH REST API with fetch (zero dependencies, browser-compatible)

import { getProtocolId } from "../protocol-state.ts";
import {
	DEFAULT_HIVE_ENDPOINTS,
	DEFAULT_HIVE_TIMEOUT_MS,
} from "./constants.ts";
import type {
	HiveL1Config,
	HafahTransaction,
	L1ParsedOperation,
} from "./types.ts";

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

// ============ OPERATION ID FETCHER ============

const CUSTOM_JSON_OP_TYPE = 18;

/**
 * Fetches the HafAH operation_id for a specific NFTLox custom_json in a block.
 * Uses the HafAH operations endpoint which returns per-operation IDs.
 */
export async function fetchOperationId(
	config: HiveL1Config,
	txId: string,
	blockNum: number,
): Promise<string> {
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

			for (const op of ops) {
				const entry = op as Record<string, unknown>;
				if (entry.trx_id !== txId) continue;
				const opValue = (entry.op as Record<string, unknown>)?.value as Record<string, unknown> | undefined;
				if (opValue?.id !== protocolId) continue;
				if (typeof entry.operation_id === "string") return entry.operation_id;
				if (typeof entry.operation_id === "number") return String(entry.operation_id);
			}

			// Data error — retrying another endpoint won't help (same blockchain)
			throw new HiveRpcError(
				`No NFTLox operation found for tx ${txId} in block ${blockNum}`,
				endpoint,
			);
		} catch (err) {
			// Data errors (HiveRpcError from us) should not be retried
			if (err instanceof HiveRpcError) throw err;
			errors.push({ endpoint, error: err });
		}
	}

	const details = errors
		.map((e) => `${e.endpoint}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
		.join("; ");
	throw new HiveRpcError(`All endpoints failed for operationId: ${details}`, config.endpoints[0] ?? "unknown");
}

// ============ OPERATION PARSER ============

/**
 * Parses an NFTLox custom_json operation from a HAFAH transaction.
 * Returns null if no NFTLox operation is found.
 *
 * @param operationId — The HafAH operation_id, fetched separately via fetchOperationId().
 *                       Required for SPV pack_open verification (RNG seed reproducibility).
 */
export function parseNftloxOperation(
	tx: HafahTransaction,
	operationId = "",
): L1ParsedOperation | null {
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
			continue;
		}

		if (!parsed.protocol || !parsed.version || !parsed.action || !parsed.data) {
			continue;
		}

		const signer =
			value.required_auths?.[0]
			?? value.required_posting_auths?.[0]
			?? "";

		if (!signer) continue;

		return {
			txId: tx.transaction_id,
			blockNum: tx.block_num,
			signer,
			action: parsed.action,
			data: parsed.data,
			operationId,
		};
	}

	return null;
}
