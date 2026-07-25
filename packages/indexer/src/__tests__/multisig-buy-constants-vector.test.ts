// Frozen-vector test for the buy-time constants that gate the multisig
// settlement loop. Every value here is observable on-chain (via emitted
// `buy_commitment` op TTL) or in the DB (via `multisig_buy_locks.expires_at`,
// its `retryAfterMs` derivation, and the divergence-gate's
// `MAX_NODE_HEARTBEAT_STALENESS_BLOCKS` comparison).
//
// Rule: changing any value below is a hardfork. Re-generate this file in
// the same PR that flips the constant, alongside the ADR that explains the
// change. See [[feedback_freeze_protocol_helpers_with_pinned_vectors]].

import { describe, expect, test } from "bun:test";
import {
	BUY_API_HEAD_STALENESS_MAX_MS,
	BUY_API_LAG_MAX_BLOCKS,
	BUY_COMMITMENT_OBSERVATION_TIMEOUT_MS,
	BUY_COMMITMENT_TTL_BLOCKS,
	BUY_TX_TTL_MS,
	HIVE_BLOCK_TIME_MS,
	HIVE_FINALITY_SAFETY_BLOCKS,
	MAX_ACTIVE_COMMITMENTS_PER_NODE,
	MAX_NODE_HEARTBEAT_STALENESS_BLOCKS,
	MULTISIG_TX_MAX_EXPIRATION_MS,
	MULTISIG_TX_MIN_EXPIRATION_MS,
	RECOMMENDED_BUY_TX_EXPIRATION_MS,
} from "@/protocol/index.ts";

describe("multisig buy-time constants — frozen vectors", () => {
	test("BUY_TX_TTL_MS pins the buy-side on-chain and lock window", () => {
		// Used by multisig_buy_locks.expires_at and the buyLock's
		// downstream retryAfterMs.
		expect(BUY_TX_TTL_MS).toBe(120_000);
	});

	test("BUY_COMMITMENT_OBSERVATION_TIMEOUT_MS is the HTTP wait budget", () => {
		// waitForCommitmentVictory's deadline. Shorter than BUY_TX_TTL_MS by
		// design — the on-chain commitment and the local buyLock outlive it.
		expect(BUY_COMMITMENT_OBSERVATION_TIMEOUT_MS).toBe(60_000);
	});

	test("BUY_COMMITMENT_TTL_BLOCKS = BUY_TX_TTL_MS / HIVE_BLOCK_TIME_MS", () => {
		// Source-of-truth derivation: 120_000 / 3_000 = 40 blocks. The
		// commitment lives on chain for this many blocks before the handler
		// sweep returns the NFT to listed.
		expect(BUY_COMMITMENT_TTL_BLOCKS).toBe(40);
		expect(BUY_TX_TTL_MS / HIVE_BLOCK_TIME_MS).toBe(BUY_COMMITMENT_TTL_BLOCKS);
	});

	test("MAX_ACTIVE_COMMITMENTS_PER_NODE caps concurrent pending_sale reservations", () => {
		// Per-node ceiling observed by the divergence/active-state read path.
		// Consumers of l2_nodes apply this when picking a node for a fresh buy.
		expect(MAX_ACTIVE_COMMITMENTS_PER_NODE).toBe(10);
	});

	test("BUY_API_LAG_MAX_BLOCKS gates the indexer-vs-irreversible health check", () => {
		// assertMultisigSyncHealthy rejects with INDEXER_LAGGED when
		// hive_irreversible_block - last_block > this value.
		expect(BUY_API_LAG_MAX_BLOCKS).toBe(3);
	});

	test("BUY_API_HEAD_STALENESS_MAX_MS catches RPC outages", () => {
		// assertMultisigSyncHealthy rejects when hive_head_time is older
		// than this. Distinct from BUY_API_LAG_MAX_BLOCKS: lag math can look
		// healthy while the timestamp reference is stale.
		expect(BUY_API_HEAD_STALENESS_MAX_MS).toBe(30_000);
	});

	test("MAX_NODE_HEARTBEAT_STALENESS_BLOCKS — gap after which a node is inactive", () => {
		// assertActiveSettlementNode enforces this on the BUY_MULTISIG_STATUS
		// → NODE_NOT_ACTIVE branch. Two missed heartbeats = inactive.
		expect(MAX_NODE_HEARTBEAT_STALENESS_BLOCKS).toBe(10_000);
	});

	test("MULTISIG_TX_MAX_EXPIRATION_MS equals BUY_TX_TTL_MS", () => {
		// The signed buy cannot remain broadcastable after the reservation
		// window ends, so MAX equals the commitment TTL.
		expect(MULTISIG_TX_MAX_EXPIRATION_MS).toBe(BUY_TX_TTL_MS);
		expect(MULTISIG_TX_MAX_EXPIRATION_MS).toBe(120_000);
	});

	test("RECOMMENDED_BUY_TX_EXPIRATION_MS equals MULTISIG_TX_MAX_EXPIRATION_MS", () => {
		// SDK default pin: first-class callers get the full finality-safe
		// orchestration window. Any divergence here requires a coordinated
		// SDK + indexer change.
		expect(RECOMMENDED_BUY_TX_EXPIRATION_MS).toBe(MULTISIG_TX_MAX_EXPIRATION_MS);
	});

	test("MULTISIG_TX_MIN_EXPIRATION_MS = HIVE_FINALITY_SAFETY_BLOCKS * HIVE_BLOCK_TIME_MS + 30_000", () => {
		// MIN = 20 × 3_000 + 30_000 = 90_000. Finality-budgeted floor on
		// the buyer's signed tx expiration.
		expect(MULTISIG_TX_MIN_EXPIRATION_MS).toBe(90_000);
		expect(HIVE_FINALITY_SAFETY_BLOCKS * HIVE_BLOCK_TIME_MS + 30_000).toBe(MULTISIG_TX_MIN_EXPIRATION_MS);
	});

	test("MIN_EXPIRATION < MAX_EXPIRATION (off-by-one safety net)", () => {
		// Catches a hardfork where one constant is bumped but the other is
		// not — leaving the buy window empty. Cheap sanity invariant.
		expect(MULTISIG_TX_MIN_EXPIRATION_MS).toBeLessThan(MULTISIG_TX_MAX_EXPIRATION_MS);
	});

	test("OBSERVATION timeout is strictly less than the on-chain lock TTL", () => {
		// Catches a flipped relation: if OBSERVATION_TIMEOUT > BUY_TX_TTL_MS,
		// the HTTP wait would outlast the on-chain guarantee, and the node
		// could wait forever for a commitment that the handler has already
		// swept back to listed.
		expect(BUY_COMMITMENT_OBSERVATION_TIMEOUT_MS).toBeLessThan(BUY_TX_TTL_MS);
	});

	test("HIVE_BLOCK_TIME_MS plate (3 s)", () => {
		// Every minute-to-blocks conversion in the buy flow funnels through
		// this value. A hardfork on HIVE_BLOCK_TIME_MS would break every
		// *_BLOCKS constant in the suite.
		expect(HIVE_BLOCK_TIME_MS).toBe(3_000);
	});
});
