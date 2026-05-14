import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "@/db/client.ts";
import { assertBuyFinalSigningAllowed } from "@/api/services/multisig/buy.ts";
import { setDivergentAtBlock } from "@/db/queries/state-root.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";
import {
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

async function setSyncBlocks(lastBlock: number, hiveHeadBlock = lastBlock): Promise<void> {
	await sql`
		UPDATE sync_state
		SET last_block = ${lastBlock},
		    hive_head_block = ${hiveHeadBlock},
		    hive_head_time = NOW()
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

	test("rejects if the indexer is too far behind Hive head", async () => {
		await setSyncBlocks(100, 100 + BUY_API_LAG_MAX_BLOCKS + 1);

		await expect(assertBuyFinalSigningAllowed(buildCtx())).rejects.toMatchObject({
			code: "INDEXER_LAGGED",
		});
	});

	test("allows final signing when divergence, lag, and node activity are clean", async () => {
		await expect(assertBuyFinalSigningAllowed(buildCtx())).resolves.toBeUndefined();
	});
});
