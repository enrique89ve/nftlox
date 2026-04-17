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
	type StateRootDelta,
} from "@/utils/state-root-hash.ts";
import type { StateRootBuffer, BufferedMutation } from "@/utils/state-root-buffer.ts";

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
}>;

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
		SELECT state_root, nft_count, last_block_num, updated_at
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
	};
}

// Reads state_meta WITH a row lock so the caller sees a consistent snapshot
// and the subsequent UPDATE cannot race another session. Caller MUST be in
// the same transaction that mutates the NFT row.
async function selectForUpdate(txn: Queryable): Promise<Uint8Array> {
	const [row] = await txn`
		SELECT state_root FROM state_meta
		WHERE id = ${STATE_META_ID}
		FOR UPDATE
	`;
	if (!row) throw new Error("state_meta row missing — schema bootstrap did not run");
	const buffer = toUint8(row.state_root);
	assertRootBytes(buffer);
	return buffer;
}

// Writes the new root + counter delta + block advance. Block advance is
// monotonic (never moves backwards) so a late handler in the same batch
// does not regress the cursor.
async function writeRoot(
	txn: Queryable,
	newRoot: Uint8Array,
	countDelta: number,
	blockNum: number,
): Promise<void> {
	assertRootBytes(newRoot);
	await txn`
		UPDATE state_meta
		SET state_root = ${Buffer.from(newRoot)},
		    nft_count = nft_count + ${countDelta},
		    last_block_num = GREATEST(last_block_num, ${blockNum}),
		    updated_at = NOW()
		WHERE id = ${STATE_META_ID}
	`;
}

export type StateRootMutation =
	| Readonly<{ type: "insert"; newRow: NftStateRow; blockNum: number }>
	| Readonly<{ type: "update"; oldRow: NftStateRow; newRow: NftStateRow; blockNum: number }>
	| Readonly<{ type: "delete"; oldRow: NftStateRow; blockNum: number }>;

function countDeltaOf(mutation: StateRootMutation): number {
	switch (mutation.type) {
		case "insert": return 1;
		case "delete": return -1;
		case "update": return 0;
	}
}

function toDelta(mutation: StateRootMutation): StateRootDelta {
	switch (mutation.type) {
		case "insert": return { type: "insert", newRow: mutation.newRow };
		case "delete": return { type: "delete", oldRow: mutation.oldRow };
		case "update": return { type: "update", oldRow: mutation.oldRow, newRow: mutation.newRow };
	}
}

// Apply a single mutation atomically with the caller's transaction.
export async function applyStateRootDeltaToDb(
	mutation: StateRootMutation,
	txn: Queryable,
): Promise<void> {
	const current = await selectForUpdate(txn);
	const next = await applyDelta(current, toDelta(mutation));
	await writeRoot(txn, next, countDeltaOf(mutation), mutation.blockNum);
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
				yield {
					id: String(row.id),
					owner: String(row.owner),
					previous_owner: row.previous_owner === null ? null : String(row.previous_owner),
					owner_action: String(row.owner_action),
					owner_operation_id: String(row.owner_operation_id),
					owner_block_num: Number(row.owner_block_num),
				};
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

// ============ DEFERRED APPLY (R4) ============

// Queues a delta into the tx-scoped buffer. Replaces applyStateRootDeltaToDb
// for hot-path writes — the buffer is flushed exactly once per transaction by
// withTransaction(), eliminating the per-mutation SELECT … FOR UPDATE contention
// that otherwise caps throughput at ~1-3k ops/sec regardless of hardware.
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
