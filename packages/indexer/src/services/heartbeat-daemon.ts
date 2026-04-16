/**
 * Heartbeat daemon — periodic `node_heartbeat` emitter.
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
 * 60 s cadence is plenty for a 5000-block (≈4 h) protocol floor.
 *
 * Signing flow:
 *   - Build custom_json payload via `@nftlox/sdk` → `buildNodeHeartbeat`.
 *   - Assemble `Transaction` via `hive-tx` with the single custom_json op.
 *   - Compute the digest, call `signPostingDigest()` (posting key in beekeeper
 *     WASM — WIF never re-materialises in JS memory), attach signature.
 *   - Broadcast via `Transaction.broadcast()` which handles failover + retries
 *     internally using `hive-tx`'s `config.nodes`.
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
import { getFormattedStateRoot } from "@/db/queries/state-root.ts";
import { getHeadBlockNum } from "@/scanner/hive-client.ts";
import {
	MIN_HEARTBEAT_INTERVAL_BLOCKS,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	createPayload,
	type NodeHeartbeatData,
} from "@/protocol/index.ts";

const log = createLogger("heartbeat-daemon");

const POLL_INTERVAL_MS = 60_000;

// ============ STATE (module-scoped, single instance) ============

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastEmittedBlock = 0;
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

async function tick(): Promise<void> {
	if (!running || inFlight) return;

	const currentBlock = await getHeadBlockNum();
	if (currentBlock - lastEmittedBlock < MIN_HEARTBEAT_INTERVAL_BLOCKS) return;

	inFlight = true;
	try {
		await emitHeartbeat(currentBlock);
		// Only advance the cursor once broadcast resolves — if it throws, we retry
		// on the next poll with the same `lastEmittedBlock`.
		lastEmittedBlock = currentBlock;
	} finally {
		inFlight = false;
	}
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
