import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { Queryable } from "@/db/client.ts";
import { STATE_CHECKPOINT_INTERVAL_BLOCKS } from "@/protocol/index.ts";
import { requireBoundedString } from "@/utils/validation.ts";

// Mirrors `formatStateRoot()` / `stateRootSchema` shared with node_heartbeat.
// Kept local (rather than imported from the heartbeat handler) so the two
// handlers can drift independently if a future format change ever applies to
// only one of them.
const STATE_ROOT_REGEX = /^sha256:[0-9a-f]{64}$/;
const MAX_STATE_ROOT_LENGTH = 128;

function requirePositiveInt(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`Missing or invalid '${fieldName}' parameter: expected positive integer`);
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

async function loadRegisteredAccount(account: string, txn: Queryable): Promise<boolean> {
	const [row] = await txn`
		SELECT 1 AS present
		FROM l2_nodes
		WHERE account = ${account}
	`;
	return row !== undefined;
}

/**
 * Persists a `node_state_checkpoint` op from a registered node.
 *
 * Guards (all fail-fast with a clear reason so the op lands in
 * `invalid_operations` with a useful diagnostic):
 *   - `data.blockNum`  — positive integer divisible by
 *     STATE_CHECKPOINT_INTERVAL_BLOCKS. Off-boundary values are rejected so
 *     two honest nodes that produced checkpoints at the same boundary land
 *     comparable rows in this table.
 *   - `data.stateRoot` — matches `^sha256:[0-9a-f]{64}$`.
 *   - Signer is present in `l2_nodes` (checkpoints from unregistered accounts
 *     are meaningless — the daemon only emits after the registry insert).
 *
 * On success, inserts a row into `l2_node_checkpoints`. F3.A is emission-only:
 * this handler does NOT compare the received root against the local one and
 * does NOT advance any divergence flag — that work belongs to F3.B.
 */
export async function handleNodeStateCheckpoint(
	op: ParsedOperation,
	txn: Queryable,
): Promise<ReadonlyArray<string>> {
	const blockNum = requirePositiveInt(op.data.blockNum, "blockNum");
	if (blockNum % STATE_CHECKPOINT_INTERVAL_BLOCKS !== 0) {
		throw new Error(
			`Invalid 'blockNum' parameter: ${blockNum} is not aligned to STATE_CHECKPOINT_INTERVAL_BLOCKS=${STATE_CHECKPOINT_INTERVAL_BLOCKS}`,
		);
	}
	const stateRoot = requireStateRoot(op.data.stateRoot);

	const registered = await loadRegisteredAccount(op.signer, txn);
	if (!registered) {
		throw new Error(
			`Account '${op.signer}' is not registered in l2_nodes — checkpoints require a prior node_register`,
		);
	}

	await txn`
		INSERT INTO l2_node_checkpoints (
			account,
			block_num,
			state_root,
			tx_id
		) VALUES (
			${op.signer},
			${blockNum},
			${stateRoot},
			${op.txId}
		)
	`;

	return []; // This action evaluates node state, it emits no immutable NFT ids
}
