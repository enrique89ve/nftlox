import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { handleNodeHeartbeat } from "@/processor/handlers/core/node_heartbeat.ts";
import {
	ACTION_NODE_HEARTBEAT,
	MIN_HEARTBEAT_INTERVAL_BLOCKS,
} from "@/protocol/index.ts";

const VALID_STATE_ROOT = `sha256:${"a".repeat(64)}`;
const TEST_ACCOUNT = "heartbeat-node";
const UNREGISTERED_ACCOUNT = "stranger-node";
const NODE_ENDPOINT = "https://heartbeat.example.com";
const NODE_PUBLIC_KEY = "STM6MRyAjQq8ud7hVNYcfnVPJqcVpscN5SoFMugdoJ2M6YB8Wf7b2";

let opCounter = 0;

function makeHeartbeatOp(
	data: Record<string, unknown>,
	overrides: Partial<ParsedOperation> = {},
): ParsedOperation {
	const id = ++opCounter;
	return {
		blockNum: 100_000_000,
		timestamp: "2026-04-16T00:00:00",
		txId: `tx_hb_${id}`,
		operationId: `op_hb_${id}`,
		signer: TEST_ACCOUNT,
		authLevel: "posting",
		action: ACTION_NODE_HEARTBEAT as ParsedOperation["action"],
		version: "0.5.3",
		data,
		...overrides,
	};
}

async function insertRegisteredNode(account: string, lastHeartbeatBlock: number | null = null): Promise<void> {
	await sql`
		INSERT INTO l2_nodes (account, endpoint, public_key, status, last_heartbeat_block, block_num, tx_id)
		VALUES (${account}, ${NODE_ENDPOINT}, ${NODE_PUBLIC_KEY}, 'active', ${lastHeartbeatBlock}, 99999999, 'tx_register_1')
		ON CONFLICT (account) DO UPDATE SET
			last_heartbeat_block = EXCLUDED.last_heartbeat_block
	`;
}

async function resetL2(): Promise<void> {
	await sql`DELETE FROM l2_node_heartbeats`;
	await sql`DELETE FROM l2_nodes`;
}

describe("handleNodeHeartbeat", () => {
	beforeAll(async () => {
		// Schema is bootstrapped by handlers.test.ts; this suite only owns the
		// l2_* tables and cleans them up before every test.
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
	});

	afterAll(async () => {
		await resetL2();
	});

	beforeEach(async () => {
		await resetL2();
	});

	test("rejects heartbeat from unregistered account", async () => {
		const op = makeHeartbeatOp(
			{ blockNum: 100_000_000, stateRoot: VALID_STATE_ROOT, indexerVersion: "0.5.3" },
			{ signer: UNREGISTERED_ACCOUNT },
		);
		await expect(handleNodeHeartbeat(op, sql)).rejects.toThrow(/not registered in l2_nodes/);

		const [row] = await sql`SELECT COUNT(*)::int AS c FROM l2_node_heartbeats`;
		expect(row?.c).toBe(0);
	});

	test("rejects malformed stateRoot", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);
		const op = makeHeartbeatOp({
			blockNum: 100_000_000,
			stateRoot: "sha256:NOT_HEX",
			indexerVersion: "0.5.3",
		});
		await expect(handleNodeHeartbeat(op, sql)).rejects.toThrow(/stateRoot/);
	});

	test("rejects negative blockNum", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);
		const op = makeHeartbeatOp({
			blockNum: -1,
			stateRoot: VALID_STATE_ROOT,
			indexerVersion: "0.5.3",
		});
		await expect(handleNodeHeartbeat(op, sql)).rejects.toThrow(/blockNum/);
	});

	test("rejects empty indexerVersion", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);
		const op = makeHeartbeatOp({
			blockNum: 100_000_000,
			stateRoot: VALID_STATE_ROOT,
			indexerVersion: "   ",
		});
		await expect(handleNodeHeartbeat(op, sql)).rejects.toThrow(/indexerVersion/);
	});

	test("rejects heartbeat closer than MIN_HEARTBEAT_INTERVAL_BLOCKS to last one", async () => {
		const lastBlock = 100_000_000;
		await insertRegisteredNode(TEST_ACCOUNT, lastBlock);

		const tooSoon = lastBlock + (MIN_HEARTBEAT_INTERVAL_BLOCKS - 1);
		const op = makeHeartbeatOp(
			{ blockNum: tooSoon, stateRoot: VALID_STATE_ROOT, indexerVersion: "0.5.3" },
			{ blockNum: tooSoon },
		);

		await expect(handleNodeHeartbeat(op, sql)).rejects.toThrow(/too soon/);
	});

	test("accepts valid heartbeat, persists row, and advances last_heartbeat_block", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);

		const currentBlock = 100_000_500;
		const op = makeHeartbeatOp(
			{ blockNum: currentBlock, stateRoot: VALID_STATE_ROOT, indexerVersion: "0.5.3" },
			{ blockNum: currentBlock },
		);

		const result = await handleNodeHeartbeat(op, sql);
		expect(result).toEqual([]);

		const hbRows = await sql`
			SELECT account, block_num, state_root, indexer_version, tx_id
			FROM l2_node_heartbeats
			WHERE account = ${TEST_ACCOUNT}
		`;
		expect(hbRows.length).toBe(1);
		expect(String(hbRows[0]!.account)).toBe(TEST_ACCOUNT);
		expect(Number(hbRows[0]!.block_num)).toBe(currentBlock);
		expect(String(hbRows[0]!.state_root)).toBe(VALID_STATE_ROOT);
		expect(String(hbRows[0]!.indexer_version)).toBe("0.5.3");

		const [nodeRow] = await sql`
			SELECT last_heartbeat_block FROM l2_nodes WHERE account = ${TEST_ACCOUNT}
		`;
		expect(Number(nodeRow!.last_heartbeat_block)).toBe(currentBlock);
	});

	test("second heartbeat after interval elapsed is accepted", async () => {
		const firstBlock = 100_000_000;
		await insertRegisteredNode(TEST_ACCOUNT, firstBlock);

		const secondBlock = firstBlock + MIN_HEARTBEAT_INTERVAL_BLOCKS;
		const op = makeHeartbeatOp(
			{ blockNum: secondBlock, stateRoot: VALID_STATE_ROOT, indexerVersion: "0.5.3" },
			{ blockNum: secondBlock },
		);

		await handleNodeHeartbeat(op, sql);

		const [nodeRow] = await sql`
			SELECT last_heartbeat_block FROM l2_nodes WHERE account = ${TEST_ACCOUNT}
		`;
		expect(Number(nodeRow!.last_heartbeat_block)).toBe(secondBlock);
	});
});
