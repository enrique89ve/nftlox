import { sql, type Queryable } from "@/db/client.ts";
import { MAX_NODE_HEARTBEAT_STALENESS_BLOCKS } from "@/protocol/index.ts";

type NodeStatus = "active" | "banned";

type NodeRegistryRow = Readonly<{
	account: string;
	status: string;
	block_num: number | string;
	last_heartbeat_block: number | string | null;
}>;

type NodeProfileRow = NodeRegistryRow & Readonly<{
	endpoint: string;
	public_key: string;
	tx_id: string;
	created_at: Date | string;
	updated_at: Date | string;
}>;

type NodeHeartbeatRow = Readonly<{
	block_num: number | string;
	state_root: string;
	indexer_version: string;
	tx_id: string;
	created_at: Date | string;
}>;

type IndexedNodeOperationRow = Readonly<{
	status: string;
	tx_id: string;
	operation_id: string | null;
	signer: string | null;
	action: string | null;
	reason: string | null;
	block_num: number | string;
	timestamp: Date | string;
	nft_ids: ReadonlyArray<string> | null;
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

export type NodeHeartbeatRecord = Readonly<{
	blockNum: number;
	stateRoot: string;
	indexerVersion: string;
	txId: string;
	createdAt: string;
}>;

export type NodeProfile = SettlementNodeSnapshot & Readonly<{
	endpoint: string;
	publicKey: string;
	registrationTxId: string;
	createdAt: string;
	updatedAt: string;
	heartbeatCount: number;
	lastHeartbeat: NodeHeartbeatRecord | null;
}>;

export type IndexedNodeOperationStatus = "confirmed" | "invalid";

export type IndexedNodeOperation = Readonly<{
	status: IndexedNodeOperationStatus;
	txId: string;
	operationId: string | null;
	signer: string | null;
	action: string | null;
	reason: string | null;
	blockNum: number;
	timestamp: string;
	nftIds: ReadonlyArray<string>;
}>;

export type IndexedNodeOperationsPage = Readonly<{
	account: string;
	total: number;
	offset: number;
	limit: number;
	operations: ReadonlyArray<IndexedNodeOperation>;
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

function toIsoString(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : String(value);
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

export async function getNodeProfile(
	account: string,
	evaluationBlock: number,
	txn: Queryable = sql,
): Promise<NodeProfile | null> {
	const normalizedAccount = account.trim().toLowerCase();
	const [row, snapshot, lastHeartbeatRow, heartbeatCountRow] = await Promise.all([
		txn<NodeProfileRow[]>`
			SELECT account, endpoint, public_key, status, block_num, tx_id, created_at, updated_at, last_heartbeat_block
			FROM l2_nodes
			WHERE account = ${normalizedAccount}
		`,
		getSettlementNodeSnapshot(normalizedAccount, evaluationBlock, txn),
		txn<NodeHeartbeatRow[]>`
			SELECT block_num, state_root, indexer_version, tx_id, created_at
			FROM l2_node_heartbeats
			WHERE account = ${normalizedAccount}
			ORDER BY block_num DESC
			LIMIT 1
		`,
		txn<{ count: number | string }[]>`
			SELECT COUNT(*) AS count
			FROM l2_node_heartbeats
			WHERE account = ${normalizedAccount}
		`,
	]);

	const base = row[0];
	if (!base || !snapshot) return null;

	const lastHeartbeat = lastHeartbeatRow[0]
		? {
			blockNum: toSafeBlock(lastHeartbeatRow[0].block_num, "l2_node_heartbeats.block_num"),
			stateRoot: lastHeartbeatRow[0].state_root,
			indexerVersion: lastHeartbeatRow[0].indexer_version,
			txId: lastHeartbeatRow[0].tx_id,
			createdAt: toIsoString(lastHeartbeatRow[0].created_at),
		} satisfies NodeHeartbeatRecord
		: null;

	return {
		...snapshot,
		endpoint: base.endpoint,
		publicKey: base.public_key,
		registrationTxId: base.tx_id,
		createdAt: toIsoString(base.created_at),
		updatedAt: toIsoString(base.updated_at),
		heartbeatCount: Number(heartbeatCountRow[0]?.count ?? 0),
		lastHeartbeat,
	};
}

export async function listIndexedNodeOperations(
	account: string,
	pagination: Readonly<{ limit: number; offset: number }>,
	txn: Queryable = sql,
): Promise<IndexedNodeOperationsPage> {
	const normalizedAccount = account.trim().toLowerCase();
	const [countRow, rows] = await Promise.all([
		txn<{ total: number | string }[]>`
			SELECT
				(SELECT COUNT(*) FROM confirmed_operations WHERE signer = ${normalizedAccount}) +
				(SELECT COUNT(*) FROM invalid_operations WHERE signer = ${normalizedAccount}) AS total
		`,
		txn<IndexedNodeOperationRow[]>`
			SELECT status, tx_id, operation_id, signer, action, reason, block_num, timestamp, nft_ids
			FROM (
				SELECT
					'confirmed'::text AS status,
					tx_id,
					operation_id,
					signer,
					action,
					NULL::text AS reason,
					block_num,
					created_at AS timestamp,
					nft_ids
				FROM confirmed_operations
				WHERE signer = ${normalizedAccount}
				UNION ALL
				SELECT
					'invalid'::text AS status,
					tx_id,
					operation_id,
					signer,
					action,
					reason,
					block_num,
					indexed_at AS timestamp,
					NULL::text[] AS nft_ids
				FROM invalid_operations
				WHERE signer = ${normalizedAccount}
			) ops
			ORDER BY block_num DESC, timestamp DESC
			LIMIT ${pagination.limit}
			OFFSET ${pagination.offset}
		`,
	]);

	return {
		account: normalizedAccount,
		total: Number(countRow[0]?.total ?? 0),
		offset: pagination.offset,
		limit: pagination.limit,
		operations: rows.map((row) => ({
			status: row.status === "invalid" ? "invalid" : "confirmed",
			txId: row.tx_id,
			operationId: row.operation_id,
			signer: row.signer,
			action: row.action,
			reason: row.reason,
			blockNum: toSafeBlock(row.block_num, "node operations block_num"),
			timestamp: toIsoString(row.timestamp),
			nftIds: Array.isArray(row.nft_ids) ? row.nft_ids.map((id) => String(id)) : [],
		})),
	};
}
