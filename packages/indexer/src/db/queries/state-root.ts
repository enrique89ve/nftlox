import { sql, type Queryable } from "@/db/client.ts";
import {
	applyDelta,
	computeStateRootFullScan,
	emptyStateRoot,
	formatStateRoot,
	hashRow,
	xorInto,
	STATE_ROOT_BYTES,
	type NftStateRow,
} from "@/utils/state-root-hash.ts";
import type { StateRootBuffer, BufferedMutation } from "@/utils/state-root-buffer.ts";
import { STATE_CHECKPOINT_INTERVAL_BLOCKS } from "@/protocol/index.ts";

// DB adapter for the incremental state-root.
//
// The hashing algebra lives in `utils/state-root-hash.ts` (pure, testable).
// This file is the ONLY place that writes `state_meta` and is responsible for:
//   1. Serializing concurrent mutations (SELECT ... FOR UPDATE).
//   2. Advancing nft_count and last_block_num atomically with the root.
//   3. Bootstrapping the root from a full table scan when the row is zero.
//
// Every call MUST receive a `txn` that already wraps the actual NFT mutation,
// so a crash between the NFT row change and the root update cannot desync the
// two — the whole batch rolls back together.

export type StateMetaRow = Readonly<{
	state_root: Uint8Array;
	nft_count: number;
	last_block_num: number;
	updated_at: string;
	// F3.B/F3.C — non-null means divergence with another node was detected at
	// the given block. Multisig signing endpoints must refuse to operate while
	// this is set (see api/services/multisig/buy.ts and create-collection.ts).
	divergent_at_block: number | null;
}>;

function describeValue(v: unknown): string {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	if (typeof v === "string") return `string(length=${v.length})`;
	return typeof v;
}

// Guards the DB→hash boundary. Every NftStateRow that feeds the state-root
// XOR algebra MUST come through this parser. A silent `String(null) → "null"`
// or `Number(undefined) → NaN` would hash to a valid-looking 32 bytes and
// only surface weeks later as an audit divergence — by then state_meta is
// already corrupt across every indexer replica.
export function parseNftStateRow(row: Record<string, unknown>): NftStateRow {
	const id = row.id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`NftStateRow.id: expected non-empty string, got ${describeValue(id)}`);
	}
	const owner = row.owner;
	if (typeof owner !== "string" || owner.length === 0) {
		throw new Error(`NftStateRow.owner: expected non-empty string, got ${describeValue(owner)} (id=${id})`);
	}
	const previousOwnerRaw = row.previous_owner;
	let previous_owner: string | null;
	if (previousOwnerRaw === null) {
		previous_owner = null;
	} else if (typeof previousOwnerRaw === "string" && previousOwnerRaw.length > 0) {
		previous_owner = previousOwnerRaw;
	} else {
		throw new Error(
			`NftStateRow.previous_owner: expected null or non-empty string, got ${describeValue(previousOwnerRaw)} (id=${id})`,
		);
	}
	const ownerAction = row.owner_action;
	if (typeof ownerAction !== "string" || ownerAction.length === 0) {
		throw new Error(`NftStateRow.owner_action: expected non-empty string, got ${describeValue(ownerAction)} (id=${id})`);
	}
	const ownerOperationId = row.owner_operation_id;
	if (typeof ownerOperationId !== "string" || ownerOperationId.length === 0) {
		throw new Error(
			`NftStateRow.owner_operation_id: expected non-empty string, got ${describeValue(ownerOperationId)} (id=${id})`,
		);
	}
	const ownerBlockRaw = row.owner_block_num;
	let owner_block_num: number;
	if (typeof ownerBlockRaw === "number") {
		owner_block_num = ownerBlockRaw;
	} else if (typeof ownerBlockRaw === "bigint") {
		owner_block_num = Number(ownerBlockRaw);
	} else if (typeof ownerBlockRaw === "string") {
		owner_block_num = Number(ownerBlockRaw);
	} else {
		throw new Error(
			`NftStateRow.owner_block_num: expected number|bigint|string, got ${describeValue(ownerBlockRaw)} (id=${id})`,
		);
	}
	if (!Number.isFinite(owner_block_num) || !Number.isInteger(owner_block_num) || owner_block_num < 0) {
		throw new Error(
			`NftStateRow.owner_block_num: expected non-negative integer, got ${describeValue(ownerBlockRaw)} (id=${id})`,
		);
	}
	return {
		id,
		owner,
		previous_owner,
		owner_action: ownerAction,
		owner_operation_id: ownerOperationId,
		owner_block_num,
	};
}

const STATE_META_ID = 1;

function toUint8(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (value instanceof Buffer) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	throw new Error(`state_meta.state_root: expected bytea, got ${typeof value}`);
}

function assertRootBytes(buffer: Uint8Array): void {
	if (buffer.length !== STATE_ROOT_BYTES) {
		throw new Error(
			`state_meta.state_root: expected ${STATE_ROOT_BYTES} bytes, got ${buffer.length}`,
		);
	}
}

export async function getStateMeta(txn: Queryable = sql): Promise<StateMetaRow> {
	const [row] = await txn`
		SELECT state_root, nft_count, last_block_num, updated_at, divergent_at_block
		FROM state_meta
		WHERE id = ${STATE_META_ID}
	`;
	if (!row) {
		throw new Error("state_meta row missing — schema bootstrap did not run");
	}
	const stateRoot = toUint8(row.state_root);
	assertRootBytes(stateRoot);
	const nftCount = Number(row.nft_count);
	const lastBlockNum = Number(row.last_block_num);
	if (!Number.isFinite(nftCount) || nftCount < 0) {
		throw new Error(`state_meta.nft_count invalid: ${row.nft_count}`);
	}
	if (!Number.isFinite(lastBlockNum) || lastBlockNum < 0) {
		throw new Error(`state_meta.last_block_num invalid: ${row.last_block_num}`);
	}
	return {
		state_root: stateRoot,
		nft_count: nftCount,
		last_block_num: lastBlockNum,
		updated_at: String(row.updated_at),
		divergent_at_block: parseDivergentAtBlock(row.divergent_at_block),
	};
}

// `divergent_at_block` is BIGINT NULL — pg driver may surface it as
// number | bigint | string | null. Coerce to a finite positive number, or null
// if the column is unset. Anything else is corrupt: fail loudly so the multisig
// gate can never silently mistake a corrupt value for "clean".
function parseDivergentAtBlock(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		throw new Error(`state_meta.divergent_at_block invalid: ${String(raw)}`);
	}
	return n;
}

// One-time bootstrap: rebuild the root from a full scan over the current
// nfts table. Safe to re-run; always overwrites. Streams in pages so memory
// stays bounded even at 10M rows.
const BOOTSTRAP_PAGE_SIZE = 5_000;

export async function bootstrapStateRootFromFullScan(
	txn: Queryable = sql,
): Promise<StateMetaRow> {
	async function* streamRows(): AsyncGenerator<NftStateRow> {
		let lastId = "";
		for (;;) {
			const page = await txn`
				SELECT id, owner, previous_owner, owner_action, owner_operation_id, owner_block_num
				FROM nfts
				WHERE id > ${lastId}
				ORDER BY id ASC
				LIMIT ${BOOTSTRAP_PAGE_SIZE}
			`;
			if (page.length === 0) return;
			for (const row of page) {
				yield parseNftStateRow(row as Record<string, unknown>);
			}
			lastId = String(page[page.length - 1]!.id);
			if (page.length < BOOTSTRAP_PAGE_SIZE) return;
		}
	}

	let root = emptyStateRoot();
	let count = 0;
	let maxBlock = 0;
	for await (const row of streamRows()) {
		root = await applyDelta(root, { type: "insert", newRow: row });
		count += 1;
		if (row.owner_block_num > maxBlock) maxBlock = row.owner_block_num;
	}

	await txn`
		UPDATE state_meta
		SET state_root = ${Buffer.from(root)},
		    nft_count = ${count},
		    last_block_num = ${maxBlock},
		    updated_at = NOW()
		WHERE id = ${STATE_META_ID}
	`;

	return {
		state_root: root,
		nft_count: count,
		last_block_num: maxBlock,
		updated_at: new Date().toISOString(),
		// Bootstrap rebuilds the canonical root from full scan — the divergence
		// flag is independent state owned by the heartbeat daemon, so we
		// surface whatever the operator left in the column (typically NULL on a
		// fresh genesis replay).
		divergent_at_block: null,
	};
}

// Convenience read for the HTTP layer.
export async function getFormattedStateRoot(): Promise<Readonly<{
	state_root: string;
	nft_count: number;
	last_block_num: number;
	updated_at: string;
}>> {
	const meta = await getStateMeta();
	return {
		state_root: formatStateRoot(meta.state_root),
		nft_count: meta.nft_count,
		last_block_num: meta.last_block_num,
		updated_at: meta.updated_at,
	};
}

// Re-export full-scan for audit jobs that want to compare incremental vs
// reference without touching the hashing module directly.
export { computeStateRootFullScan };

/**
 * Records a state-root checkpoint into `state_root_checkpoints` IFF
 * `blockNum` is a positive multiple of STATE_CHECKPOINT_INTERVAL_BLOCKS.
 * Idempotent via ON CONFLICT — re-applying the same boundary on a crash
 * replay leaves the existing row untouched.
 *
 * Pure DB write; the caller must invoke this inside the same transaction
 * that just flushed the SPV state-root for `blockNum` so the snapshot
 * captures the root AT that exact boundary, not a later head value.
 */
export async function recordCheckpointIfBoundary(
	blockNum: number,
	stateRoot: Uint8Array,
	txn: Queryable,
): Promise<void> {
	if (!Number.isInteger(blockNum) || blockNum <= 0) return;
	if (blockNum % STATE_CHECKPOINT_INTERVAL_BLOCKS !== 0) return;
	if (stateRoot.length !== STATE_ROOT_BYTES) {
		throw new Error(
			`recordCheckpointIfBoundary: state_root must be ${STATE_ROOT_BYTES} bytes, got ${stateRoot.length}`,
		);
	}
	await txn`
		INSERT INTO state_root_checkpoints (block_num, state_root)
		VALUES (${blockNum}, ${Buffer.from(stateRoot)})
		ON CONFLICT (block_num) DO NOTHING
	`;
}

/**
 * F3.B — Divergence detection. Returns the highest block_num where our local
 * state_root snapshot disagrees with at least one other node's
 * `node_state_checkpoint` for the same boundary, or null if no disagreement
 * exists.
 *
 * Symmetric semantics: any peer disagreeing with us at the same block triggers
 * a hit. We do NOT try to determine which side is correct — that's an operator
 * investigation. With 3+ nodes and one byzantine, both honest peers will see
 * the byzantine disagree and flag themselves; the byzantine flags itself too
 * if it runs honest comparator code. Conservative-but-correct.
 *
 * The query JOINs the BYTEA local snapshot against the TEXT on-chain
 * checkpoints by formatting the BYTEA side to "sha256:<hex>" inside the query
 * — keeps a single round-trip and reuses the (account, block_num) index on
 * `l2_node_checkpoints`.
 *
 * Edge cases handled:
 *   - Empty `state_root_checkpoints` → JOIN yields no row → null.
 *   - Empty `l2_node_checkpoints` → JOIN yields no row → null.
 *   - Boundary B exists locally but no peer has a checkpoint at B → null at B.
 *     (Absence of a peer datum is NOT divergence.)
 *   - Multiple peers disagree at B → returns ANY ONE (LIMIT 1). We only need
 *     to know SOMETHING disagreed, not how many.
 */
export type DivergentCheckpoint = Readonly<{
	blockNum: number;
	ourRoot: string;
	theirAccount: string;
	theirRoot: string;
}>;

export async function findHighestDivergentCheckpointBlock(
	ourAccount: string,
	txn: Queryable = sql,
): Promise<DivergentCheckpoint | null> {
	if (typeof ourAccount !== "string" || ourAccount.length === 0) {
		throw new Error(
			`findHighestDivergentCheckpointBlock: ourAccount must be non-empty string, got ${describeValue(ourAccount)}`,
		);
	}
	const [row] = await txn`
		SELECT
			us.block_num AS block_num,
			'sha256:' || encode(us.state_root, 'hex') AS our_root,
			them.account AS their_account,
			them.state_root AS their_root
		FROM state_root_checkpoints us
		JOIN l2_node_checkpoints them
			ON them.block_num = us.block_num
			AND them.account != ${ourAccount}
			AND them.state_root != ('sha256:' || encode(us.state_root, 'hex'))
		ORDER BY us.block_num DESC
		LIMIT 1
	`;
	if (!row) return null;
	const blockNum = Number(row.block_num);
	if (!Number.isFinite(blockNum) || !Number.isInteger(blockNum) || blockNum <= 0) {
		throw new Error(
			`findHighestDivergentCheckpointBlock: block_num invalid: ${describeValue(row.block_num)}`,
		);
	}
	const ourRoot = row.our_root;
	const theirAccount = row.their_account;
	const theirRoot = row.their_root;
	if (typeof ourRoot !== "string" || ourRoot.length === 0) {
		throw new Error(`findHighestDivergentCheckpointBlock: our_root invalid: ${describeValue(ourRoot)}`);
	}
	if (typeof theirAccount !== "string" || theirAccount.length === 0) {
		throw new Error(
			`findHighestDivergentCheckpointBlock: their_account invalid: ${describeValue(theirAccount)}`,
		);
	}
	if (typeof theirRoot !== "string" || theirRoot.length === 0) {
		throw new Error(
			`findHighestDivergentCheckpointBlock: their_root invalid: ${describeValue(theirRoot)}`,
		);
	}
	return { blockNum, ourRoot, theirAccount, theirRoot };
}

/**
 * F3.B — Sets `state_meta.divergent_at_block` to GREATEST(current, blockNum).
 * Monotonic on a single tick: a later call with a lower block cannot lower the
 * flag. Operator clears it manually after investigation. The flag is a
 * single-bit alarm; diagnostic detail (peer account, roots) lives in the
 * structured log emitted by the daemon, not in extra columns.
 */
export async function setDivergentAtBlock(
	blockNum: number,
	txn: Queryable = sql,
): Promise<void> {
	if (!Number.isInteger(blockNum) || blockNum <= 0) {
		throw new Error(`setDivergentAtBlock: blockNum must be positive integer, got ${blockNum}`);
	}
	await txn`
		UPDATE state_meta
		SET divergent_at_block = GREATEST(COALESCE(divergent_at_block, 0), ${blockNum}),
		    updated_at = NOW()
		WHERE id = ${STATE_META_ID}
	`;
}

// Queues a delta into the tx-scoped buffer. The buffer is flushed exactly once
// per transaction by withTransaction(), eliminating the per-mutation
// SELECT … FOR UPDATE contention that otherwise caps throughput at ~1-3k
// ops/sec regardless of hardware.
export function queueStateRootDelta(
	buffer: StateRootBuffer,
	mutation: BufferedMutation,
): void {
	buffer.queue(mutation);
}

// Flushes the net buffer to state_meta in a single SELECT + UPDATE. Called by
// withTransaction() just before the tx commits. No-op when the buffer is empty
// (pure-read tx, or a tx that touched only non-SPV columns like listing price).
export async function flushStateRootBuffer(
	buffer: StateRootBuffer,
	txn: Queryable,
): Promise<void> {
	if (buffer.isEmpty()) return;

	const [row] = await txn`
		SELECT state_root FROM state_meta
		WHERE id = ${STATE_META_ID}
		FOR UPDATE
	`;
	if (!row) throw new Error("state_meta row missing — schema bootstrap did not run");
	let root = toUint8(row.state_root);
	assertRootBytes(root);

	let countDelta = 0;

	for (const entry of buffer.iter()) {
		const { firstOld, lastNew } = entry;
		if (firstOld === null && lastNew === null) continue; // insert+delete cancels out

		if (firstOld !== null) {
			const oldHash = await hashRow(firstOld);
			root = xorInto(root, oldHash);
		}
		if (lastNew !== null) {
			const newHash = await hashRow(lastNew);
			root = xorInto(root, newHash);
		}
		if (firstOld === null && lastNew !== null) countDelta += 1;
		else if (firstOld !== null && lastNew === null) countDelta -= 1;
		// else: net update — countDelta unchanged
	}

	const maxBlock = buffer.maxBlockNum();
	await txn`
		UPDATE state_meta
		SET state_root = ${Buffer.from(root)},
		    nft_count = nft_count + ${countDelta},
		    last_block_num = GREATEST(last_block_num, ${maxBlock}),
		    updated_at = NOW()
		WHERE id = ${STATE_META_ID}
	`;
}
