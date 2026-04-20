import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { handleNodeRegister } from "@/processor/handlers/core/node_register.ts";
import { getSettlementNodeSnapshot } from "@/db/queries/nodes.ts";
import {
	ACTION_NODE_REGISTER,
	MAX_NODE_HEARTBEAT_STALENESS_BLOCKS,
} from "@/protocol/index.ts";

const TEST_ACCOUNT = "register-node";
const NODE_ENDPOINT = "https://register.example.com";
const NODE_PUBLIC_KEY = "STM6MRyAjQq8ud7hVNYcfnVPJqcVpscN5SoFMugdoJ2M6YB8Wf7b2";

let opCounter = 0;

function makeRegisterOp(blockNum: number, overrides: Partial<ParsedOperation> = {}): ParsedOperation {
	const id = ++opCounter;
	return {
		blockNum,
		timestamp: "2026-04-20T00:00:00",
		txId: `tx_reg_${id}`,
		operationId: `op_reg_${id}`,
		signer: TEST_ACCOUNT,
		authLevel: "posting",
		action: ACTION_NODE_REGISTER as ParsedOperation["action"],
		version: "0.6.1",
		data: { endpoint: NODE_ENDPOINT, publicKey: NODE_PUBLIC_KEY },
		...overrides,
	};
}

async function resetL2(): Promise<void> {
	await sql`DELETE FROM l2_node_heartbeats`;
	await sql`DELETE FROM l2_nodes`;
}

describe("handleNodeRegister — activity and status invariants", () => {
	beforeAll(async () => {
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
	});

	afterAll(async () => {
		await resetL2();
	});

	beforeEach(async () => {
		await resetL2();
	});

	test("fresh registration seeds activity from registeredBlock (grace window)", async () => {
		const registerBlock = 1_000;
		await handleNodeRegister(makeRegisterOp(registerBlock), sql);

		// Immediately after register, node is active (grace window for first heartbeat).
		const snapshot = await getSettlementNodeSnapshot(TEST_ACCOUNT, registerBlock);
		expect(snapshot).not.toBeNull();
		expect(snapshot!.activeForSettlement).toBe(true);
		expect(snapshot!.activityBlock).toBe(registerBlock);
	});

	test("re-register does NOT refresh activityBlock once a heartbeat exists", async () => {
		// Seed: node registered at block 1000 with a heartbeat at block 6000.
		const firstRegisterBlock = 1_000;
		const heartbeatBlock = 6_000;
		await handleNodeRegister(makeRegisterOp(firstRegisterBlock), sql);
		await sql`
			UPDATE l2_nodes
			SET last_heartbeat_block = ${heartbeatBlock}
			WHERE account = ${TEST_ACCOUNT}
		`;

		// Advance evaluation past the staleness window (heartbeat at 6000, window 10000).
		const staleEvaluationBlock = heartbeatBlock + MAX_NODE_HEARTBEAT_STALENESS_BLOCKS + 1;

		// Sanity check: node is currently stale.
		let snapshot = await getSettlementNodeSnapshot(TEST_ACCOUNT, staleEvaluationBlock);
		expect(snapshot!.activeForSettlement).toBe(false);
		expect(snapshot!.reason).toMatch(/node activity is stale/);

		// Attacker's move: re-register to "reset the clock" without heartbeat.
		await handleNodeRegister(makeRegisterOp(staleEvaluationBlock), sql);

		// Post-fix: activity must NOT be refreshed by re-register.
		snapshot = await getSettlementNodeSnapshot(TEST_ACCOUNT, staleEvaluationBlock);
		expect(snapshot!.activityBlock).toBe(heartbeatBlock);
		expect(snapshot!.activeForSettlement).toBe(false);
		expect(snapshot!.reason).toMatch(/node activity is stale/);
	});

	test("re-register preserves 'banned' status (immune to self-unban)", async () => {
		const firstRegisterBlock = 1_000;
		await handleNodeRegister(makeRegisterOp(firstRegisterBlock), sql);

		// Simulate a future ban mechanism writing 'banned' directly.
		await sql`UPDATE l2_nodes SET status = 'banned' WHERE account = ${TEST_ACCOUNT}`;

		// Attacker's move: re-register to reset status to 'active'.
		const secondRegisterBlock = firstRegisterBlock + 100;
		await handleNodeRegister(makeRegisterOp(secondRegisterBlock), sql);

		// Post-fix: status must stay 'banned'; settlement must reject.
		const [row] = await sql`SELECT status FROM l2_nodes WHERE account = ${TEST_ACCOUNT}`;
		expect(row!.status).toBe("banned");

		const snapshot = await getSettlementNodeSnapshot(TEST_ACCOUNT, secondRegisterBlock);
		expect(snapshot!.status).toBe("banned");
		expect(snapshot!.activeForSettlement).toBe(false);
		expect(snapshot!.reason).toMatch(/node status is 'banned'/);
	});

	test("re-register still refreshes endpoint, public_key, block_num, tx_id", async () => {
		const firstRegisterBlock = 1_000;
		await handleNodeRegister(makeRegisterOp(firstRegisterBlock), sql);

		const newEndpoint = "https://register-rotated.example.com";
		const newKey = "STM8ZSyzjPm48GmUuMSRufkVYkwYbZzbxeMysAVp7KFQwbTf98TcG";
		const secondRegisterBlock = firstRegisterBlock + 500;
		await handleNodeRegister(
			makeRegisterOp(secondRegisterBlock, {
				data: { endpoint: newEndpoint, publicKey: newKey },
				txId: "tx_reg_rotated",
			}),
			sql,
		);

		const [row] = await sql`
			SELECT endpoint, public_key, block_num, tx_id
			FROM l2_nodes WHERE account = ${TEST_ACCOUNT}
		`;
		expect(row!.endpoint).toBe(newEndpoint);
		expect(row!.public_key).toBe(newKey);
		expect(Number(row!.block_num)).toBe(secondRegisterBlock);
		expect(row!.tx_id).toBe("tx_reg_rotated");
	});
});
