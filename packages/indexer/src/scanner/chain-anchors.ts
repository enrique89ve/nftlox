/**
 * Chain-anchor verification — run before `syncCycle` takes its first step.
 *
 * Single check: the Hive block at `PROTOCOL_GENESIS_BLOCK` must have the
 * block_id we hard-coded into the protocol. A compromised HafAH hand-rolling a
 * fake chain from scratch is caught here before it can write any state.
 *
 * Cross-verified against `MIN_ANCHOR_QUORUM` independent Hive endpoints; fewer
 * responders aborts rather than pretending the chain is verified. Beyond
 * genesis we rely on Hive's own DPoS finality — forging a fake block past it
 * requires breaking consensus, not just swapping a REST endpoint.
 */

import { getBlockIdFromAllEndpoints } from "./hive-client.ts";
import {
	PROTOCOL_GENESIS_BLOCK,
	PROTOCOL_GENESIS_BLOCK_ID,
} from "@/protocol/index.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("chain-anchors");

const MIN_ANCHOR_QUORUM = 2;

export class ChainAnchorMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChainAnchorMismatchError";
	}
}

/**
 * Single entry-point called from `startSync()`. Throws `ChainAnchorMismatchError`
 * on any failure; the caller must surface it and refuse to start the sync loop.
 */
export async function verifyChainAnchors(): Promise<void> {
	const samples = await getBlockIdFromAllEndpoints(PROTOCOL_GENESIS_BLOCK);
	if (samples.length < MIN_ANCHOR_QUORUM) {
		throw new ChainAnchorMismatchError(
			`Cannot verify genesis anchor: only ${samples.length}/${MIN_ANCHOR_QUORUM} endpoints responded. ` +
			`Configure at least ${MIN_ANCHOR_QUORUM} independent Hive endpoints in HIVE_ENDPOINTS.`,
		);
	}

	const bad = samples.filter(s => s.blockId !== PROTOCOL_GENESIS_BLOCK_ID);
	if (bad.length > 0) {
		throw new ChainAnchorMismatchError(
			`Genesis anchor mismatch at block ${PROTOCOL_GENESIS_BLOCK}: expected ${PROTOCOL_GENESIS_BLOCK_ID}, ` +
			`but endpoints returned ${JSON.stringify(bad)}. ` +
			`Refusing to sync against an inconsistent chain.`,
		);
	}

	log.info("Genesis anchor verified", {
		blockNum: PROTOCOL_GENESIS_BLOCK,
		blockId: PROTOCOL_GENESIS_BLOCK_ID,
		confirmedBy: samples.map(s => s.endpoint),
	});
}
