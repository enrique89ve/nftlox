import { Elysia, t } from "elysia";
import { config } from "@/config.ts";
import { getLastBlock } from "@/db/queries/sync.ts";
import {
	getNodeProfile,
	listIndexedNodeOperations,
	type IndexedNodeOperation,
} from "@/db/queries/nodes.ts";
import {
	getBlockchainHead,
	getCustomJsonInRange,
	getHafAHBlockRange,
} from "@/scanner/hive-client.ts";
import {
	parseHafAHOperations,
	type ParsedOperation,
	type RejectedOperation,
} from "@/scanner/operation-parser.ts";

const DEFAULT_INDEXED_LIMIT = 50;
const DEFAULT_HIVE_LIMIT = 25;

export type NodeHiveOperationStatus = "parsed" | "rejected";

export type NodeHiveOperation = Readonly<{
	status: NodeHiveOperationStatus;
	txId: string;
	operationId: string;
	blockNum: number;
	timestamp: string;
	signer: string | null;
	authLevel: ParsedOperation["authLevel"] | null;
	action: ParsedOperation["action"] | null;
	version: string | null;
	reason: string | null;
	data: Record<string, unknown> | null;
}>;

export type NodeHiveOperationsPage = Readonly<{
	account: string;
	fromBlock: number;
	toBlock: number;
	windowBlocks: number;
	limit: number;
	total: number;
	rejected: number;
	operations: ReadonlyArray<NodeHiveOperation>;
}>;

function sortHiveOperationsDescending(
	a: Pick<NodeHiveOperation, "blockNum" | "timestamp" | "operationId">,
	b: Pick<NodeHiveOperation, "blockNum" | "timestamp" | "operationId">,
): number {
	if (a.blockNum !== b.blockNum) return b.blockNum - a.blockNum;
	if (a.timestamp !== b.timestamp) return String(b.timestamp).localeCompare(String(a.timestamp));
	return String(b.operationId).localeCompare(String(a.operationId), undefined, { numeric: true });
}

function mapParsedHiveOperation(op: ParsedOperation): NodeHiveOperation {
	return {
		status: "parsed",
		txId: op.txId,
		operationId: op.operationId,
		blockNum: op.blockNum,
		timestamp: op.timestamp,
		signer: op.signer,
		authLevel: op.authLevel,
		action: op.action,
		version: op.version,
		reason: null,
		data: op.data,
	};
}

function mapRejectedHiveOperation(op: RejectedOperation): NodeHiveOperation {
	return {
		status: "rejected",
		txId: op.txId,
		operationId: op.operationId,
		blockNum: op.blockNum,
		timestamp: "",
		signer: op.signer,
		authLevel: null,
		action: null,
		version: null,
		reason: op.reason,
		data: null,
	};
}

function normalizeNodeAccount(value: string): string {
	return value.trim().toLowerCase();
}

function filterHiveOperationsBySigner<T extends { signer: string | null }>(
	ops: readonly T[],
	account: string,
): T[] {
	return ops.filter((op) => op.signer?.toLowerCase() === account);
}

export const nodesRoutes = new Elysia({ prefix: "/api/nodes", tags: ["Nodes"] })
	.get("/:account", async ({ params, set }) => {
		const account = normalizeNodeAccount(params.account);
		const lastBlock = await getLastBlock();
		const profile = await getNodeProfile(account, lastBlock);
		if (!profile) {
			set.status = 404;
			return { error: "Node not found" };
		}
		return profile;
	}, {
		params: t.Object({ account: t.String({ minLength: 3, maxLength: 16 }) }),
		detail: {
			summary: "Get node profile",
			description: "Returns registry metadata, heartbeat summary, and settlement liveness for one node account.",
		},
	})
	.get("/:account/operations", async ({ params, query }) => {
		const account = normalizeNodeAccount(params.account);
		return listIndexedNodeOperations(account, { limit: query.limit, offset: query.offset });
	}, {
		params: t.Object({ account: t.String({ minLength: 3, maxLength: 16 }) }),
		query: t.Object({
			limit: t.Number({ default: DEFAULT_INDEXED_LIMIT, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: {
			summary: "List indexed protocol operations signed by a node",
			description: "Returns confirmed and invalid protocol operations whose signer is this node account, ordered newest-first.",
		},
	})
	.get("/:account/hive-operations", async ({ params, query }) => {
		const account = normalizeNodeAccount(params.account);
		const chain = await getBlockchainHead();
		const toBlock = chain.irreversibleBlock > 0 ? chain.irreversibleBlock : chain.headBlock;
		const maxWindow = getHafAHBlockRange();
		const windowBlocks = Math.min(query.windowBlocks, maxWindow);
		const fromBlock = Math.max(config.genesisBlock, toBlock - windowBlocks + 1);
		const hafOps = await getCustomJsonInRange(fromBlock, toBlock, config.protocolId, 0);
		const parsed = parseHafAHOperations(hafOps);
		const parsedOps = filterHiveOperationsBySigner(parsed.ops, account).map(mapParsedHiveOperation);
		const rejectedOps = filterHiveOperationsBySigner(parsed.rejected, account).map(mapRejectedHiveOperation);
		const operations = [...parsedOps, ...rejectedOps]
			.sort(sortHiveOperationsDescending)
			.slice(0, query.limit);

		return {
			account,
			fromBlock,
			toBlock,
			windowBlocks,
			limit: query.limit,
			total: parsedOps.length + rejectedOps.length,
			rejected: rejectedOps.length,
			operations,
		} satisfies NodeHiveOperationsPage;
	}, {
		params: t.Object({ account: t.String({ minLength: 3, maxLength: 16 }) }),
		query: t.Object({
			limit: t.Number({ default: DEFAULT_HIVE_LIMIT, minimum: 1, maximum: 100 }),
			windowBlocks: t.Number({ default: getHafAHBlockRange(), minimum: 1, maximum: getHafAHBlockRange() }),
		}),
		detail: {
			summary: "List recent Hive L1 protocol operations signed by a node",
			description: "Scans recent irreversible blocks via HafAH, parses protocol custom_json operations, and filters them by signer account.",
		},
	});
