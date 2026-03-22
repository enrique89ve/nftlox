// Hive L1 Client — HafAH REST API + JSON-RPC fallback

import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("hive-client");

let currentEndpointIndex = 0;

function getCurrentEndpoint(): string {
	return config.hiveEndpoints[currentEndpointIndex] ?? config.hiveEndpoints[0]!;
}

function rotateEndpoint(): string {
	currentEndpointIndex = (currentEndpointIndex + 1) % config.hiveEndpoints.length;
	const next = getCurrentEndpoint();
	log.warn("Rotating endpoint", { endpoint: next });
	return next;
}

// ============ JSON-RPC (for head block only) ============

async function rpcCall<T>(endpoint: string, method: string, params: Record<string, unknown>): Promise<T> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 15_000);

	const response = await fetch(endpoint, {
		method: "POST",
		signal: controller.signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
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

	return json.result as T;
}

async function callWithFailover<T>(method: string, params: Record<string, unknown>): Promise<T> {
	const maxRetries = config.hiveEndpoints.length * 2;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const endpoint = getCurrentEndpoint();
		try {
			return await rpcCall<T>(endpoint, method, params);
		} catch (err) {
			log.warn(`RPC failed: ${endpoint} (${attempt + 1}/${maxRetries})`, {
				error: err instanceof Error ? err.message : String(err),
			});

			rotateEndpoint();

			if (attempt === maxRetries - 1) throw err;

			const delay = Math.min(1000 * (attempt + 1), 5000);
			await new Promise(r => setTimeout(r, delay));
		}
	}

	throw new Error("All Hive endpoints exhausted");
}

// ============ HAFAH REST API ============

export interface HafAHOperation {
	op: {
		type: string;
		value: {
			id: string;
			json: string;
			required_auths: string[];
			required_posting_auths: string[];
		};
	};
	block: number;
	trx_id: string;
	timestamp: string;
	operation_id: string;
	virtual_op: boolean;
}

interface HafAHResponse {
	ops: HafAHOperation[];
	next_block_range_begin: number | null;
	next_operation_begin: string | null;
}

// HafAH page-size limits: server allows up to 150,000 ops per page.
// During massive sync we request more ops per page to reduce round-trips.
// Near the head, fewer custom_json ops exist so a smaller page suffices.
const HAFAH_PAGE_SIZE_NORMAL = 1000;
const HAFAH_PAGE_SIZE_MASSIVE = 5000;
const MASSIVE_SYNC_THRESHOLD = 100;

// HafAH enforces a hard limit of 2000 blocks per request (server-side assert)
const HAFAH_BLOCK_RANGE = 2000;
// Hive protocol operation type ID for custom_json (immutable blockchain constant)
const CUSTOM_JSON_OP_TYPE = 18;

async function hafahFetch(endpoint: string, fromBlock: number, toBlock: number, operationBegin: string, pageSize: number): Promise<HafAHResponse> {
	// Adaptive timeout: larger pages need more time for server-side query + transfer
	const timeoutMs = pageSize > HAFAH_PAGE_SIZE_NORMAL ? 45_000 : 15_000;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const url = `${endpoint}/hafah-api/operations?from-block=${fromBlock}&to-block=${toBlock}&operation-types=${CUSTOM_JSON_OP_TYPE}&page-size=${pageSize}&operation-begin=${operationBegin}`;

	const response = await fetch(url, { signal: controller.signal });
	clearTimeout(timeoutId);

	if (!response.ok) {
		throw new Error(`HafAH HTTP ${response.status}: ${response.statusText}`);
	}

	const data = await response.json() as Record<string, unknown>;

	// Validate response structure
	if (!Array.isArray(data.ops)) {
		return { ops: [], next_block_range_begin: null, next_operation_begin: null };
	}

	return data as unknown as HafAHResponse;
}

async function hafahWithFailover(fromBlock: number, toBlock: number, operationBegin: string, pageSize: number): Promise<HafAHResponse> {
	const maxRetries = config.hiveEndpoints.length;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const endpoint = getCurrentEndpoint();
		try {
			return await hafahFetch(endpoint, fromBlock, toBlock, operationBegin, pageSize);
		} catch (err) {
			log.warn(`HafAH failed: ${endpoint} (${attempt + 1}/${maxRetries})`, {
				error: err instanceof Error ? err.message : String(err),
			});

			rotateEndpoint();

			if (attempt === maxRetries - 1) throw err;
			await new Promise(r => setTimeout(r, 1000));
		}
	}

	throw new Error("All HafAH endpoints exhausted");
}

// ============ PUBLIC API ============

export async function getHeadBlockNum(): Promise<number> {
	// Use HafAH headblock endpoint (faster + more reliable than JSON-RPC)
	const maxRetries = config.hiveEndpoints.length;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const endpoint = getCurrentEndpoint();
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 30_000);
			const response = await fetch(`${endpoint}/hafah-api/headblock`, { signal: controller.signal });
			clearTimeout(timeoutId);
			const text = await response.text();
			const blockNum = parseInt(text, 10);
			if (Number.isNaN(blockNum)) throw new Error(`Invalid headblock: ${text}`);
			return blockNum;
		} catch (err) {
			log.warn(`HafAH headblock failed: ${endpoint} (${attempt + 1}/${maxRetries})`, {
				error: err instanceof Error ? err.message : String(err),
			});
			rotateEndpoint();
			if (attempt === maxRetries - 1) throw err;
			await new Promise(r => setTimeout(r, 1000));
		}
	}
	throw new Error("All endpoints exhausted for headblock");
}

/**
 * Fetch ALL custom_json operations in a block range using HafAH.
 * Handles cursor pagination automatically.
 * Returns operations grouped by block for compatibility with existing parser.
 */
export async function getCustomJsonInRange(fromBlock: number, toBlock: number, protocolId: string, behind = 0): Promise<HafAHOperation[]> {
	const pageSize = behind > MASSIVE_SYNC_THRESHOLD
		? HAFAH_PAGE_SIZE_MASSIVE
		: HAFAH_PAGE_SIZE_NORMAL;

	const allOps: HafAHOperation[] = [];
	let operationBegin = "-1";
	let pages = 0;
	const maxPages = 100;

	while (pages < maxPages) {
		const result = await hafahWithFailover(fromBlock, toBlock, operationBegin, pageSize);
		const ops = result.ops;

		if (ops.length === 0) break;

		// Filter to only our protocol operations
		const ours = ops.filter(op => op.op.value.id === protocolId);
		allOps.push(...ours);
		pages++;

		// Last page (incomplete) — no more data
		if (ops.length < pageSize) break;

		if (result.next_operation_begin) {
			operationBegin = result.next_operation_begin;
		} else {
			break;
		}
	}

	if (allOps.length > 0) {
		log.debug("HafAH found", { fromBlock, toBlock, pages, protocolOps: allOps.length });
	}

	return allOps;
}

/** Optimal block range for HafAH queries */
export function getHafAHBlockRange(): number {
	return HAFAH_BLOCK_RANGE;
}

// ============ TRANSFER VERIFICATION (for pack_buy payment checks) ============

const NAI_TO_CURRENCY: Record<string, string> = {
	"@@000000021": "HIVE",
	"@@000000013": "HBD",
};

export interface TransferDetail {
	from: string;
	to: string;
	amount: number;
	currency: string;
	memo: string;
}

function parseTransferAmount(raw: unknown): { amount: number; currency: string } | null {
	// NAI format: { amount: "1000", precision: 3, nai: "@@000000021" }
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
		const nai = raw as { amount?: string; precision?: number; nai?: string };
		if (typeof nai.amount === "string" && typeof nai.precision === "number" && typeof nai.nai === "string") {
			const currency = NAI_TO_CURRENCY[nai.nai];
			if (!currency) return null;
			return { amount: parseInt(nai.amount, 10) / Math.pow(10, nai.precision), currency };
		}
	}
	// Legacy string format: "1.000 HIVE"
	if (typeof raw === "string") {
		const parts = raw.split(" ");
		if (parts.length === 2 && parts[0] && parts[1]) {
			const amount = parseFloat(parts[0]);
			if (Number.isNaN(amount)) return null;
			return { amount, currency: parts[1] };
		}
	}
	return null;
}

/**
 * Fetch all operations in a specific transaction by txId via JSON-RPC,
 * then extract transfer operations. Direct lookup — no block scan needed.
 */
export async function getTransfersInTransaction(txId: string): Promise<TransferDetail[]> {
	const result = await callWithFailover<{
		operations: Array<{ type: string; value: Record<string, unknown> }>;
	}>("account_history_api.get_transaction", { id: txId, include_reversible: true });

	const transfers: TransferDetail[] = [];
	for (const op of result.operations) {
		if (op.type !== "transfer_operation") continue;
		const val = op.value;
		if (typeof val.from !== "string" || typeof val.to !== "string") continue;

		const parsed = parseTransferAmount(val.amount);
		if (!parsed) continue;

		transfers.push({
			from: val.from,
			to: val.to,
			amount: parsed.amount,
			currency: parsed.currency,
			memo: typeof val.memo === "string" ? val.memo : "",
		});
	}

	return transfers;
}
