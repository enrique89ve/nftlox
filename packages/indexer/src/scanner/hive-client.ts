import { createHiveChain, type IHiveChainInterface } from "@hiveio/wax";
import { config } from "../config.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("hive-client");

let chain: IHiveChainInterface | null = null;
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

export async function getChain(): Promise<IHiveChainInterface> {
	if (!chain) {
		const endpoint = getCurrentEndpoint();
		log.info("Creating Hive chain", { endpoint });
		chain = await createHiveChain({ apiEndpoint: endpoint, apiTimeout: 15_000 });
	}
	return chain;
}

async function callWithFailover<T>(fn: (hive: IHiveChainInterface) => Promise<T>): Promise<T> {
	const maxRetries = config.hiveEndpoints.length * 2;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const hive = await getChain();
			return await fn(hive);
		} catch (err) {
			const endpoint = getCurrentEndpoint();
			log.warn(`API call failed on ${endpoint} (attempt ${attempt + 1}/${maxRetries})`, {
				error: err instanceof Error ? err.message : String(err),
			});

			const next = rotateEndpoint();
			if (chain) {
				chain.endpointUrl = next;
			}

			if (attempt === maxRetries - 1) throw err;

			const delay = Math.min(1000 * (attempt + 1), 5000);
			await new Promise(r => setTimeout(r, delay));
		}
	}

	throw new Error("All Hive endpoints exhausted");
}

export interface BlockData {
	blockNum: number;
	timestamp: string;
	transactions: Array<{
		txId: string;
		operations: Array<{ type: string; value: Record<string, unknown> }>;
	}>;
}

export async function getHeadBlockNum(): Promise<number> {
	return callWithFailover(async (hive) => {
		const response = await hive.api.database_api.get_dynamic_global_properties({});
		return response.head_block_number;
	});
}

function toRecord(value: object): Record<string, unknown> {
	if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
	return {};
}

export async function getBlockRange(startBlock: number, count: number): Promise<BlockData[]> {
	return callWithFailover(async (hive) => {
		const response = await hive.api.block_api.get_block_range({
			starting_block_num: startBlock,
			count,
		});

		return response.blocks.map((block, i) => ({
			blockNum: startBlock + i,
			timestamp: block.timestamp,
			transactions: block.transactions.map((tx, txIdx) => ({
				txId: block.transaction_ids[txIdx] ?? "",
				operations: tx.operations.map(op => ({
					type: op.type,
					value: toRecord(op.value),
				})),
			})),
		}));
	});
}
