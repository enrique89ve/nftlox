import { sql, type Queryable } from "@/db/client.ts";
import { MAX_NODE_HEARTBEAT_STALENESS_BLOCKS } from "@/protocol/index.ts";

type NodeStatus = "active" | "banned";

type NodeRegistryRow = Readonly<{
	account: string;
	status: string;
	block_num: number | string;
	last_heartbeat_block: number | string | null;
}>;

export type SettlementNodeSnapshot = Readonly<{
	account: string;
	status: NodeStatus;
	registeredBlock: number;
	lastHeartbeatBlock: number | null;
	activityBlock: number;
	activityAgeBlocks: number;
	activeForSettlement: boolean;
	staleAfterBlocks: number;
	reason: string | null;
}>;

function toSafeBlock(value: number | string, fieldName: string): number {
	const block = Number(value);
	if (!Number.isSafeInteger(block) || block < 0) {
		throw new Error(`Invalid ${fieldName}: ${String(value)}`);
	}
	return block;
}

function parseNodeStatus(value: string): NodeStatus {
	if (value === "active" || value === "banned") return value;
	throw new Error(`Invalid l2_nodes.status: ${value}`);
}

function normalizeNodeSnapshot(
	row: NodeRegistryRow,
	evaluationBlock: number,
): SettlementNodeSnapshot {
	const checkedEvaluationBlock = toSafeBlock(evaluationBlock, "evaluationBlock");
	const status = parseNodeStatus(row.status);
	const registeredBlock = toSafeBlock(row.block_num, "l2_nodes.block_num");
	const lastHeartbeatBlock = row.last_heartbeat_block === null
		? null
		: toSafeBlock(row.last_heartbeat_block, "l2_nodes.last_heartbeat_block");
	// Liveness is a property of the heartbeat — re-registering must not
	// refresh activity without publishing a new stateRoot. The registeredBlock
	// only seeds the grace window for nodes that never heartbeat.
	const activityBlock = lastHeartbeatBlock ?? registeredBlock;
	const activityAgeBlocks = checkedEvaluationBlock - activityBlock;

	let reason: string | null = null;
	if (status !== "active") {
		reason = `node status is '${status}'`;
	} else if (registeredBlock > checkedEvaluationBlock) {
		reason = `node registration block ${registeredBlock} is after evaluation block ${checkedEvaluationBlock}`;
	} else if (activityBlock > checkedEvaluationBlock) {
		reason = `node activity block ${activityBlock} is after evaluation block ${checkedEvaluationBlock}`;
	} else if (activityAgeBlocks > MAX_NODE_HEARTBEAT_STALENESS_BLOCKS) {
		reason = `node activity is stale: ${activityAgeBlocks} blocks old, max ${MAX_NODE_HEARTBEAT_STALENESS_BLOCKS}`;
	}

	return {
		account: row.account,
		status,
		registeredBlock,
		lastHeartbeatBlock,
		activityBlock,
		activityAgeBlocks,
		activeForSettlement: reason === null,
		staleAfterBlocks: MAX_NODE_HEARTBEAT_STALENESS_BLOCKS,
		reason,
	};
}

export async function getSettlementNodeSnapshot(
	account: string,
	evaluationBlock: number,
	txn: Queryable = sql,
): Promise<SettlementNodeSnapshot | null> {
	const [row] = await txn<NodeRegistryRow[]>`
		SELECT account, status, block_num, last_heartbeat_block
		FROM l2_nodes
		WHERE account = ${account}
	`;
	if (!row) return null;
	return normalizeNodeSnapshot(row, evaluationBlock);
}

export async function assertActiveSettlementNode(
	account: string,
	evaluationBlock: number,
	txn: Queryable = sql,
): Promise<SettlementNodeSnapshot> {
	const snapshot = await getSettlementNodeSnapshot(account, evaluationBlock, txn);
	if (!snapshot) {
		throw new Error(`Settlement node '${account}' is not registered in l2_nodes`);
	}
	if (!snapshot.activeForSettlement) {
		throw new Error(
			`Settlement node '${account}' is not active for buy settlement: ${snapshot.reason}`,
		);
	}
	return snapshot;
}
