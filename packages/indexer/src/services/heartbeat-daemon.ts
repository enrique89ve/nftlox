/**
 * Heartbeat daemon — periodic `node_heartbeat` emitter, extended (F3.A) to
 * also emit `node_state_checkpoint` ops as the local snapshot table picks
 * up new boundaries.
 *
 * Runs only when ALL three conditions are true:
 *   1. `config.nodeRegister === true`          (operator opted in)
 *   2. `isPostingSignerReady()`                (POSTING_KEY imported into beekeeper)
 *   3. The node's `config.hiveAccount` exists in `l2_nodes`
 *      (startup-time one-shot check; a future `node_register` before the next
 *       poll tick will be picked up naturally)
 *
 * The interval guard is in blocks, not wall clock, because the handler's guard
 * is block-based. Wall-clock polling just decides how often to re-check; a
 * 60 s cadence is plenty for a 5000-block (≈4 h) protocol floor on heartbeats
 * and a 1000-block (≈50 min) cadence on checkpoints.
 *
 * Signing flow:
 *   - Build custom_json payload via `@nftlox/sdk` → `buildNodeHeartbeat`.
 *   - Assemble `Transaction` via `hive-tx` with the single custom_json op.
 *   - Compute the digest, call `signPostingDigest()` (posting key in beekeeper
 *     WASM — WIF never re-materialises in JS memory), attach signature.
 *   - Broadcast via `Transaction.broadcast()` which handles failover + retries
 *     internally using `hive-tx`'s `config.nodes`.
 *
 * Checkpoint cadence (F3.A):
 *   - The local sync engine writes one row to `state_root_checkpoints` for
 *     every multiple-of-N block boundary that happens to land on a batch's
 *     final block. Mid-batch boundaries are intentionally skipped (we cannot
 *     read state_root at a past block) — other live nodes already publish
 *     those, the network closes the gap.
 *   - Each tick the daemon picks the LOWEST snapshot whose block_num is
 *     strictly greater than `lastEmittedCheckpointBlock` and broadcasts a
 *     single `node_state_checkpoint` op for it. On broadcast failure the
 *     cursor is NOT advanced, so the next tick retries the same boundary.
 *   - During massive sync the daemon may emit historical boundaries; the
 *     on-chain handler validates alignment, and other nodes receive a
 *     duplicate-of-known checkpoint that is harmless beyond a small RC cost.
 */

import { Transaction, config as hiveTxConfig, type CustomJsonOperation } from "hive-tx";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";
import {
	getPostingSignerPublicKey,
	isPostingSignerReady,
	signPostingDigest,
} from "@/api/services/beekeeper-signer.ts";
import { sql } from "@/db/client.ts";
import {
	findHighestDivergentCheckpointBlock,
	getFormattedStateRoot,
	setDivergentAtBlock,
} from "@/db/queries/state-root.ts";
import { formatStateRoot } from "@/utils/state-root-hash.ts";
import { getHeadBlockNum } from "@/scanner/hive-client.ts";
import {
	MIN_HEARTBEAT_INTERVAL_BLOCKS,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	createPayload,
	type NodeHeartbeatData,
	type NodeStateCheckpointData,
} from "@/protocol/index.ts";

const log = createLogger("heartbeat-daemon");

const POLL_INTERVAL_MS = 60_000;

// ============ STATE (module-scoped, single instance) ============

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastEmittedBlock = 0;
// Boundary block of the most recent `node_state_checkpoint` emitted by THIS
// process. Persisted between restarts via `l2_nodes.last_emitted_checkpoint_block`
// so a process bounce does not re-broadcast the trailing checkpoints already
// on chain. 0 means "no checkpoint emitted yet" (NULL in DB).
let lastEmittedCheckpointBlock = 0;
let running = false;
let inFlight = false;

// ============ PUBLIC API ============

/**
 * Starts the heartbeat daemon if all preconditions hold. Silently no-ops when
 * conditions aren't met so private nodes never see "daemon failed to start"
 * in their logs.
 */
export async function startHeartbeatDaemon(): Promise<void> {
	if (running) return;

	if (!config.nodeRegister) {
		log.debug("Heartbeat daemon disabled: NODE_REGISTER=false");
		return;
	}

	if (!isPostingSignerReady()) {
		log.warn("Heartbeat daemon not started: posting signer unavailable");
		return;
	}

	const account = config.hiveAccount;
	const registered = await isNodeRegistered(account);
	if (!registered) {
		log.info(
			`Heartbeat daemon idle: account '${account}' not yet in l2_nodes (run node_register first)`,
		);
		return;
	}

	// Hive-tx broadcasts through its own endpoint pool. Align it with the
	// indexer's configured endpoints so broadcast traffic honours operator
	// choice (and doesn't leak transactions to random default nodes).
	hiveTxConfig.nodes = [...config.hiveEndpoints];

	lastEmittedBlock = await loadLastHeartbeatBlock(account);
	lastEmittedCheckpointBlock = await loadLastEmittedCheckpointBlock(account);
	running = true;

	pollTimer = setInterval(() => {
		void tick().catch((err) => {
			log.error("Heartbeat tick crashed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}, POLL_INTERVAL_MS);

	log.info("Heartbeat daemon started", {
		account,
		lastEmittedBlock,
		lastEmittedCheckpointBlock,
		intervalBlocks: MIN_HEARTBEAT_INTERVAL_BLOCKS,
		pollIntervalMs: POLL_INTERVAL_MS,
	});
}

export function stopHeartbeatDaemon(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	running = false;
	inFlight = false;
	lastEmittedBlock = 0;
	lastEmittedCheckpointBlock = 0;
	log.info("Heartbeat daemon stopped");
}

// ============ INTERNALS ============

async function isNodeRegistered(account: string): Promise<boolean> {
	const [row] = await sql`SELECT 1 AS present FROM l2_nodes WHERE account = ${account}`;
	return row !== undefined;
}

async function loadLastHeartbeatBlock(account: string): Promise<number> {
	const [row] = await sql`
		SELECT last_heartbeat_block FROM l2_nodes WHERE account = ${account}
	`;
	const raw = row?.last_heartbeat_block;
	if (raw === null || raw === undefined) return 0;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function loadLastEmittedCheckpointBlock(account: string): Promise<number> {
	const [row] = await sql`
		SELECT last_emitted_checkpoint_block FROM l2_nodes WHERE account = ${account}
	`;
	const raw = row?.last_emitted_checkpoint_block;
	if (raw === null || raw === undefined) return 0;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

type PendingCheckpoint = Readonly<{
	blockNum: number;
	stateRoot: Uint8Array;
}>;

// Reads ONE unpublished checkpoint at a time. Picking the lowest unpublished
// boundary preserves chain ordering: the network sees checkpoints in
// increasing block_num order, which matches what F3.B will compare on.
async function loadNextPendingCheckpoint(): Promise<PendingCheckpoint | null> {
	const [row] = await sql`
		SELECT block_num, state_root
		FROM state_root_checkpoints
		WHERE block_num > ${lastEmittedCheckpointBlock}
		ORDER BY block_num ASC
		LIMIT 1
	`;
	if (!row) return null;
	const blockNum = Number(row.block_num);
	if (!Number.isFinite(blockNum) || !Number.isInteger(blockNum) || blockNum <= 0) {
		throw new Error(
			`state_root_checkpoints.block_num invalid: ${String(row.block_num)}`,
		);
	}
	const raw = row.state_root;
	let bytes: Uint8Array;
	if (raw instanceof Uint8Array) {
		bytes = raw;
	} else if (raw instanceof Buffer) {
		bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	} else {
		throw new Error(
			`state_root_checkpoints.state_root: expected bytea, got ${typeof raw}`,
		);
	}
	return { blockNum, stateRoot: bytes };
}

async function persistEmittedCheckpoint(account: string, blockNum: number): Promise<void> {
	await sql`
		UPDATE l2_nodes
		SET last_emitted_checkpoint_block = ${blockNum},
		    updated_at = NOW()
		WHERE account = ${account}
	`;
}

async function tick(): Promise<void> {
	if (!running || inFlight) return;

	inFlight = true;
	try {
		const currentBlock = await getHeadBlockNum();

		// Heartbeat: cadence is wall-clock-poll → block-block. The handler
		// rejects sub-interval emissions, so we mirror that gate locally.
		if (currentBlock - lastEmittedBlock >= MIN_HEARTBEAT_INTERVAL_BLOCKS) {
			await emitHeartbeat(currentBlock);
			// Only advance the cursor once broadcast resolves — if it throws, we
			// retry on the next poll with the same `lastEmittedBlock`.
			lastEmittedBlock = currentBlock;
		}

		// Checkpoint: independent cadence driven by `state_root_checkpoints`
		// snapshots, NOT by wall-clock polling. We emit at most one per tick
		// so a backlog is drained one boundary per minute, well below the
		// per-minute RC envelope of a posting-key custom_json.
		await tickCheckpoint();

		// Divergence: cheap indexed JOIN + LIMIT 1. Always run; the
		// no-divergence path emits no log line. On hit we set the flag
		// monotonically and log loudly so an operator grepping the log can
		// reconstruct the disagreement without querying the DB. F3.B does NOT
		// gate any API — that's F3.C.
		await tickDivergenceCheck();
	} finally {
		inFlight = false;
	}
}

async function tickCheckpoint(): Promise<void> {
	const pending = await loadNextPendingCheckpoint();
	if (!pending) return;

	await emitCheckpoint(pending);
	// Persist FIRST so a process crash between in-memory advance and DB write
	// does not re-broadcast on next start. The on-chain row already exists at
	// this point; the DB write is the durable cursor.
	await persistEmittedCheckpoint(config.hiveAccount, pending.blockNum);
	lastEmittedCheckpointBlock = pending.blockNum;
}

/**
 * F3.B — Comparator probe. Looks for the highest checkpoint block where our
 * local snapshot disagrees with any peer's `node_state_checkpoint`, and if
 * found:
 *   1. Logs an `error`-level structured event with all four diagnostic fields
 *      (blockNum, ourRoot, theirAccount, theirRoot) so an operator can
 *      reconstruct the disagreement from the log alone.
 *   2. Persists the divergence flag via `setDivergentAtBlock` (monotonic).
 *
 * Exported so the bun:test suite can drive a single tick deterministically
 * without orchestrating the full daemon loop. Production callers go through
 * `tick()`.
 */
export async function tickDivergenceCheck(): Promise<void> {
	const ourAccount = config.hiveAccount;
	const hit = await findHighestDivergentCheckpointBlock(ourAccount);
	if (!hit) return;

	log.error("STATE-ROOT DIVERGENCE DETECTED", {
		blockNum: hit.blockNum,
		ourRoot: hit.ourRoot,
		theirAccount: hit.theirAccount,
		theirRoot: hit.theirRoot,
	});
	await setDivergentAtBlock(hit.blockNum);
}

async function emitHeartbeat(currentBlock: number): Promise<void> {
	const { state_root } = await getFormattedStateRoot();

	const data: NodeHeartbeatData = {
		blockNum: currentBlock,
		stateRoot: state_root,
		indexerVersion: PROTOCOL_VERSION,
	};

	const payload = createPayload("node_heartbeat", data);
	const json = JSON.stringify(payload);

	const account = config.hiveAccount;
	const customJson: CustomJsonOperation = {
		required_auths: [],
		required_posting_auths: [account],
		id: PROTOCOL_ID,
		json,
	};

	const tx = new Transaction();
	await tx.addOperation("custom_json", customJson);

	const { digest, txId } = tx.digest();
	const sigDigestHex = Buffer.from(digest).toString("hex");
	const signature = signPostingDigest(sigDigestHex);
	tx.addSignature(signature);

	const result = await tx.broadcast();

	log.info("Heartbeat broadcast", {
		account,
		blockNum: currentBlock,
		stateRoot: state_root,
		txId,
		postingKey: getPostingSignerPublicKey(),
		result,
	});
}

// Mirrors emitHeartbeat: separate custom_json op with its own posting-signed
// transaction, so a heartbeat failure cannot back-pressure a checkpoint and
// vice-versa. The state_root carried here is the one snapshotted AT
// `pending.blockNum` (NOT the current head), which is the whole point of
// having a local snapshot table.
async function emitCheckpoint(pending: PendingCheckpoint): Promise<void> {
	const stateRoot = formatStateRoot(pending.stateRoot);

	const data: NodeStateCheckpointData = {
		blockNum: pending.blockNum,
		stateRoot,
	};

	const payload = createPayload("node_state_checkpoint", data);
	const json = JSON.stringify(payload);

	const account = config.hiveAccount;
	const customJson: CustomJsonOperation = {
		required_auths: [],
		required_posting_auths: [account],
		id: PROTOCOL_ID,
		json,
	};

	const tx = new Transaction();
	await tx.addOperation("custom_json", customJson);

	const { digest, txId } = tx.digest();
	const sigDigestHex = Buffer.from(digest).toString("hex");
	const signature = signPostingDigest(sigDigestHex);
	tx.addSignature(signature);

	const result = await tx.broadcast();

	log.info("Checkpoint broadcast", {
		account,
		blockNum: pending.blockNum,
		stateRoot,
		txId,
		postingKey: getPostingSignerPublicKey(),
		result,
	});
}
