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

const HAFAH_PAGE_SIZE = 1000;
const HAFAH_BLOCK_RANGE = 2000;
// Hive protocol operation type ID for custom_json (immutable blockchain constant)
const CUSTOM_JSON_OP_TYPE = 18;

async function hafahFetch(endpoint: string, fromBlock: number, toBlock: number, operationBegin: string): Promise<HafAHResponse> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 30_000);

	const url = `${endpoint}/hafah-api/operations?from-block=${fromBlock}&to-block=${toBlock}&operation-types=${CUSTOM_JSON_OP_TYPE}&page-size=${HAFAH_PAGE_SIZE}&operation-begin=${operationBegin}`;

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

async function hafahWithFailover(fromBlock: number, toBlock: number, operationBegin: string): Promise<HafAHResponse> {
	const maxRetries = config.hiveEndpoints.length;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const endpoint = getCurrentEndpoint();
		try {
			return await hafahFetch(endpoint, fromBlock, toBlock, operationBegin);
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

export interface BlockData {
	blockNum: number;
	timestamp: string;
	transactions: Array<{
		txId: string;
		operations: Array<{ type: string; value: Record<string, unknown> }>;
	}>;
}

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
export async function getCustomJsonInRange(fromBlock: number, toBlock: number, protocolId: string): Promise<HafAHOperation[]> {
	const allOps: HafAHOperation[] = [];
	let operationBegin = "-1";
	let pages = 0;
	const maxPages = 100;

	while (pages < maxPages) {
		const start = Date.now();
		const result = await hafahWithFailover(fromBlock, toBlock, operationBegin);
		const ops = result.ops;
		const elapsed = Date.now() - start;

		if (ops.length === 0) break;

		// Filter to only our protocol operations
		const ours = ops.filter(op => op.op.value.id === protocolId);
		allOps.push(...ours);
		pages++;

		// Early exit: if first page has no protocol ops and there are more pages,
		// very unlikely subsequent pages will either — skip rest of range
		if (pages === 1 && ours.length === 0 && ops.length === HAFAH_PAGE_SIZE) {
			log.debug("HafAH skip", { fromBlock, toBlock, totalCustomJson: ops.length, ours: 0, elapsed: `${elapsed}ms` });
			break;
		}

		if (ops.length < HAFAH_PAGE_SIZE) break;

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

// Legacy: keep for compatibility with existing code that might use it
interface RpcBlock {
	timestamp: string;
	transactions: Array<{
		operations: Array<{ type: string; value: object }>;
	}>;
	transaction_ids: string[];
}

export async function getBlockRange(startBlock: number, count: number): Promise<BlockData[]> {
	const result = await callWithFailover<{
		blocks: RpcBlock[];
	}>("block_api.get_block_range", {
		starting_block_num: startBlock,
		count,
	});

	return result.blocks.map((block, i) => ({
		blockNum: startBlock + i,
		timestamp: block.timestamp,
		transactions: block.transactions.map((tx, txIdx) => ({
			txId: block.transaction_ids[txIdx] ?? "",
			operations: tx.operations.map(op => ({
				type: op.type,
				value: (typeof op.value === "object" && op.value !== null
					? op.value
					: {}) as Record<string, unknown>,
			})),
		})),
	}));
}
