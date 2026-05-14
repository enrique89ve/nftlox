import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "@/db/client.ts";
import { assertBuyFinalSigningAllowed } from "@/api/services/multisig/buy.ts";
import { setDivergentAtBlock } from "@/db/queries/state-root.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";
import {
	BUY_API_HEAD_STALENESS_MAX_MS,
	BUY_API_LAG_MAX_BLOCKS,
	MAX_NODE_HEARTBEAT_STALENESS_BLOCKS,
} from "@/protocol/index.ts";
import type {
	BuyLockHandle,
	MultisigBuyContext,
} from "@/api/services/multisig/types.ts";
import { config } from "@/config.ts";

const NODE_ACCOUNT = config.hiveAccount;
const PROTOCOL_ID = config.protocolId;

const buyLockStub: BuyLockHandle = {
	acquire: async () => ({ acquired: true }),
	release: async () => {},
};

function buildCtx(): MultisigBuyContext {
	return {
		db: sql,
		nodeAccount: NODE_ACCOUNT,
		protocolId: PROTOCOL_ID,
		buyLock: buyLockStub,
		buyTxTtlMs: 60_000,
	};
}

// Hive finality is ~15 blocks; the realistic steady-state delta between HEAD
// and the irreversible cursor that sync writes to last_block. Tests default to
// this so the fixture mirrors how a healthy node actually looks on chain.
const HIVE_FINALITY_DELTA = 15;

interface SyncBlocksOverrides {
	hiveIrreversibleBlock?: number;
	hiveHeadBlock?: number;
	hiveHeadTime?: Date | null;
}

async function setSyncBlocks(
	lastBlock: number,
	overrides: SyncBlocksOverrides = {},
): Promise<void> {
	const hiveIrreversibleBlock = overrides.hiveIrreversibleBlock ?? lastBlock;
	const hiveHeadBlock = overrides.hiveHeadBlock ?? hiveIrreversibleBlock + HIVE_FINALITY_DELTA;
	const headTime = overrides.hiveHeadTime === null
		? null
		: (overrides.hiveHeadTime ?? new Date());
	await sql`
		UPDATE sync_state
		SET last_block = ${lastBlock},
		    hive_head_block = ${hiveHeadBlock},
		    hive_irreversible_block = ${hiveIrreversibleBlock},
		    hive_head_time = ${headTime?.toISOString() ?? null}
		WHERE id = 1
	`;
}

async function clearState(): Promise<void> {
	await sql`UPDATE state_meta SET divergent_at_block = NULL WHERE id = 1`;
	await sql`DELETE FROM l2_nodes WHERE account = ${NODE_ACCOUNT}`;
}

describe("buy multisig final signing gate", () => {
	beforeEach(async () => {
		await clearState();
		await setSyncBlocks(100);
		await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: 100 });
	});

	afterAll(async () => {
		await clearState();
	});

	test("rejects if the node becomes divergent before the final buy signature", async () => {
		await setDivergentAtBlock(123_456);

		await expect(assertBuyFinalSigningAllowed(buildCtx())).rejects.toMatchObject({
			code: "NODE_DIVERGENT",
		});
	});

test("rejects if the node is no longer active at the latest local block", async () => {
		await setSyncBlocks(100 + MAX_NODE_HEARTBEAT_STALENESS_BLOCKS + 1);

		await expect(assertBuyFinalSigningAllowed(buildCtx())).rejects.toMatchObject({
			code: "NODE_NOT_ACTIVE",
		});
	});

	test("rejects if the node would be stale at Hive HEAD signing time", async () => {
		await seedActiveSettlementNode(NODE_ACCOUNT, {
			registeredBlock: 100,
		});
		await setSyncBlocks(100 + MAX_NODE_HEARTBEAT_STALENESS_BLOCKS - 1);

		await expect(assertBuyFinalSigningAllowed(buildCtx())).rejects.toMatchObject({
			code: "NODE_NOT_ACTIVE",
		});
	});

	test("rejects when the indexer trails the irreversible cursor beyond the cap", async () => {
		// Real processing backlog: chain says irrev=100+lag+1 but we only processed 100.
		const irreversible = 100 + BUY_API_LAG_MAX_BLOCKS + 1;
		await setSyncBlocks(100, { hiveIrreversibleBlock: irreversible });

		await expect(assertBuyFinalSigningAllowed(buildCtx())).rejects.toMatchObject({
			code: "INDEXER_LAGGED",
		});
	});

	test("rejects when Hive HEAD timestamp is wall-clock stale (RPC outage)", async () => {
		// Indexer fully caught up to irreversible but hive_head_time froze: Hive
		// RPC has been unreachable for longer than the staleness budget. Without
		// this gate the API would sign a tx using a chain-time reference that's
		// minutes behind the real chain.
		const staleHeadTime = new Date(Date.now() - (BUY_API_HEAD_STALENESS_MAX_MS + 5_000));
		await setSyncBlocks(100, { hiveHeadTime: staleHeadTime });

		await expect(assertBuyFinalSigningAllowed(buildCtx())).rejects.toMatchObject({
			code: "INDEXER_LAGGED",
		});
	});

	test("allows final signing when the indexer is caught up to irreversible (HEAD naturally ahead)", async () => {
		// Regression test for the structural bug where the gate compared
		// hive_head_block - last_block: with sync writing the irreversible
		// cursor to last_block, this diff is always ≈15 in steady state, so
		// the old gate rejected every buy on a healthy indexer.
		await expect(assertBuyFinalSigningAllowed(buildCtx())).resolves.toBeUndefined();
	});
});
