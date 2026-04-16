import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { Queryable } from "@/db/client.ts";
import { MIN_HEARTBEAT_INTERVAL_BLOCKS } from "@/protocol/index.ts";
import { requireBoundedString } from "@/utils/validation.ts";

// Mirrors `formatStateRoot()` / `stateRootSchema` in the SDK.
const STATE_ROOT_REGEX = /^sha256:[0-9a-f]{64}$/;
const MAX_STATE_ROOT_LENGTH = 128;
const MAX_INDEXER_VERSION_LENGTH = 32;

function requireNonNegativeInt(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`Missing or invalid '${fieldName}' parameter: expected non-negative integer`);
	}
	return value;
}

function requireStateRoot(value: unknown): string {
	const str = requireBoundedString(value, "stateRoot", MAX_STATE_ROOT_LENGTH).trim();
	if (!STATE_ROOT_REGEX.test(str)) {
		throw new Error("Invalid 'stateRoot' parameter: expected 'sha256:<64 lowercase hex chars>'");
	}
	return str;
}

function requireIndexerVersion(value: unknown): string {
	const str = requireBoundedString(value, "indexerVersion", MAX_INDEXER_VERSION_LENGTH).trim();
	if (str === "") {
		throw new Error("Missing or invalid 'indexerVersion' parameter");
	}
	return str;
}

type NodeRow = Readonly<{ last_heartbeat_block: number | null }>;

async function loadNodeRow(account: string, txn: Queryable): Promise<NodeRow | null> {
	const [row] = await txn`
		SELECT last_heartbeat_block
		FROM l2_nodes
		WHERE account = ${account}
	`;
	if (!row) return null;
	const raw = row.last_heartbeat_block;
	const last = raw === null || raw === undefined ? null : Number(raw);
	if (last !== null && (!Number.isFinite(last) || last < 0)) {
		throw new Error(
			`l2_nodes.last_heartbeat_block invalid for '${account}': ${String(raw)}`,
		);
	}
	return { last_heartbeat_block: last };
}

/**
 * Persists a `node_heartbeat` op from a registered node.
 *
 * Guards (all fail-fast with a clear reason so the op lands in
 * `invalid_operations` with a useful diagnostic):
 *   - `data.blockNum`       — non-negative integer.
 *   - `data.stateRoot`      — matches `^sha256:[0-9a-f]{64}$`.
 *   - `data.indexerVersion` — 1–32 trimmed chars.
 *   - Signer is present in `l2_nodes` (heartbeats from unregistered accounts
 *     are meaningless — the daemon only emits after the registry insert).
 *   - Time since last heartbeat ≥ `MIN_HEARTBEAT_INTERVAL_BLOCKS`.
 *
 * On success, inserts a row into `l2_node_heartbeats` and advances
 * `l2_nodes.last_heartbeat_block` atomically with the caller's txn.
 */
export async function handleNodeHeartbeat(
	op: ParsedOperation,
	txn: Queryable,
): Promise<ReadonlyArray<string>> {
	const blockNum = requireNonNegativeInt(op.data.blockNum, "blockNum");
	const stateRoot = requireStateRoot(op.data.stateRoot);
	const indexerVersion = requireIndexerVersion(op.data.indexerVersion);

	const node = await loadNodeRow(op.signer, txn);
	if (!node) {
		throw new Error(
			`Account '${op.signer}' is not registered in l2_nodes — heartbeats require a prior node_register`,
		);
	}

	const last = node.last_heartbeat_block;
	if (last !== null && op.blockNum - last < MIN_HEARTBEAT_INTERVAL_BLOCKS) {
		throw new Error(
			`Heartbeat from '${op.signer}' too soon: ${op.blockNum - last} blocks since last, minimum ${MIN_HEARTBEAT_INTERVAL_BLOCKS}`,
		);
	}

	await txn`
		INSERT INTO l2_node_heartbeats (
			account,
			block_num,
			state_root,
			indexer_version,
			tx_id
		) VALUES (
			${op.signer},
			${blockNum},
			${stateRoot},
			${indexerVersion},
			${op.txId}
		)
	`;

	await txn`
		UPDATE l2_nodes
		SET last_heartbeat_block = ${op.blockNum},
		    updated_at = NOW()
		WHERE account = ${op.signer}
	`;

	return []; // This action evaluates node state, it emits no immutable NFT ids
}
