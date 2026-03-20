// Hive L1 Client — lightweight fetch-based (no wax/WASM dependency)

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

// ============ JSON-RPC ============

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
	const result = await callWithFailover<{
		head_block_number: number;
	}>("database_api.get_dynamic_global_properties", {});
	return result.head_block_number;
}

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
