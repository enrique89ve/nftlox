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
