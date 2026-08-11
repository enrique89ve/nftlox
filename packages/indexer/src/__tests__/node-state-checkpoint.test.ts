import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { handleNodeStateCheckpoint } from "@/processor/handlers/core/node_state_checkpoint.ts";
import {
	ACTION_NODE_STATE_CHECKPOINT,
	STATE_CHECKPOINT_INTERVAL_BLOCKS,
} from "@/protocol/index.ts";

const VALID_STATE_ROOT = `sha256:${"a".repeat(64)}`;
const TEST_ACCOUNT = "checkpoint-node";
const UNREGISTERED_ACCOUNT = "stranger-node";
const NODE_ENDPOINT = "checkpoint.example.com";

// Pinned aligned boundary so tests don't depend on wall-clock or counters.
const ALIGNED_BLOCK = 100_000_000; // 100_000_000 % 1000 === 0
const UNALIGNED_BLOCK = 100_000_001;

let opCounter = 0;

function makeCheckpointOp(
	data: Record<string, unknown>,
	overrides: Partial<ParsedOperation> = {},
): ParsedOperation {
	const id = ++opCounter;
	return {
		blockNum: ALIGNED_BLOCK,
		timestamp: "2026-04-16T00:00:00",
		txId: `tx_cp_${id}`,
		operationId: `op_cp_${id}`,
		signer: TEST_ACCOUNT,
		authLevel: "posting",
		action: ACTION_NODE_STATE_CHECKPOINT as ParsedOperation["action"],
		version: "0.11.0",
		data,
		...overrides,
	};
}

async function insertRegisteredNode(account: string): Promise<void> {
	await sql`
		INSERT INTO l2_nodes (account, endpoint, status, block_num, tx_id)
		VALUES (${account}, ${NODE_ENDPOINT}, 'active', 99999999, 'tx_register_1')
		ON CONFLICT (account) DO NOTHING
	`;
}

async function resetL2(): Promise<void> {
	await sql`DELETE FROM l2_node_checkpoints`;
	await sql`DELETE FROM l2_node_heartbeats`;
	await sql`DELETE FROM l2_nodes`;
}

describe("handleNodeStateCheckpoint", () => {
	beforeAll(async () => {
		// Schema is bootstrapped by handlers.test.ts; this suite owns the l2_*
		// tables and cleans them up before every test. Re-applying schema.sql
		// is idempotent and ensures `l2_node_checkpoints` exists when the suite
		// runs in isolation.
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
	});

	afterAll(async () => {
		await resetL2();
	});

	beforeEach(async () => {
		await resetL2();
	});

	test("aligns with STATE_CHECKPOINT_INTERVAL_BLOCKS at the constant level", () => {
		// Sanity: the intentional choice of ALIGNED_BLOCK relies on this.
		expect(ALIGNED_BLOCK % STATE_CHECKPOINT_INTERVAL_BLOCKS).toBe(0);
		expect(UNALIGNED_BLOCK % STATE_CHECKPOINT_INTERVAL_BLOCKS).not.toBe(0);
	});

	test("accepts a valid aligned checkpoint from a registered node", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);

		const op = makeCheckpointOp({ blockNum: ALIGNED_BLOCK, stateRoot: VALID_STATE_ROOT });
		const result = await handleNodeStateCheckpoint(op, sql);
		expect(result).toEqual([]);

		const rows = await sql`
			SELECT account, block_num, state_root, tx_id
			FROM l2_node_checkpoints
			WHERE account = ${TEST_ACCOUNT}
		`;
		expect(rows.length).toBe(1);
		expect(String(rows[0]!.account)).toBe(TEST_ACCOUNT);
		expect(Number(rows[0]!.block_num)).toBe(ALIGNED_BLOCK);
		expect(String(rows[0]!.state_root)).toBe(VALID_STATE_ROOT);
	});

	test("rejects unaligned blockNum (blockNum % 1000 !== 0)", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);

		const op = makeCheckpointOp({ blockNum: UNALIGNED_BLOCK, stateRoot: VALID_STATE_ROOT });
		await expect(handleNodeStateCheckpoint(op, sql)).rejects.toThrow(/aligned/);

		const [count] = await sql`SELECT COUNT(*)::int AS c FROM l2_node_checkpoints`;
		expect(count?.c).toBe(0);
	});

	test("rejects checkpoint from unregistered signer", async () => {
		const op = makeCheckpointOp(
			{ blockNum: ALIGNED_BLOCK, stateRoot: VALID_STATE_ROOT },
			{ signer: UNREGISTERED_ACCOUNT },
		);
		await expect(handleNodeStateCheckpoint(op, sql)).rejects.toThrow(/not registered in l2_nodes/);

		const [count] = await sql`SELECT COUNT(*)::int AS c FROM l2_node_checkpoints`;
		expect(count?.c).toBe(0);
	});

	test("rejects malformed stateRoot", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);

		const op = makeCheckpointOp({ blockNum: ALIGNED_BLOCK, stateRoot: "sha256:NOT_HEX" });
		await expect(handleNodeStateCheckpoint(op, sql)).rejects.toThrow(/stateRoot/);

		const [count] = await sql`SELECT COUNT(*)::int AS c FROM l2_node_checkpoints`;
		expect(count?.c).toBe(0);
	});

	// Locks the exact-length tightening — `formatStateRoot()` never emits
	// whitespace, so any padded input is malformed and must reject. Prevents
	// drift back to the legacy `.trim()`-then-check shape.
	test("rejects whitespace-padded stateRoot", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);

		const op = makeCheckpointOp({
			blockNum: ALIGNED_BLOCK,
			stateRoot: ` ${VALID_STATE_ROOT}`,
		});
		await expect(handleNodeStateCheckpoint(op, sql)).rejects.toThrow(/stateRoot/);
	});

	test("rejects non-positive blockNum (zero is structurally a sentinel, not a valid checkpoint)", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);

		const op = makeCheckpointOp({ blockNum: 0, stateRoot: VALID_STATE_ROOT });
		await expect(handleNodeStateCheckpoint(op, sql)).rejects.toThrow(/blockNum/);
	});

	test("persists the row with the boundary block, signer, state-root, and tx_id", async () => {
		await insertRegisteredNode(TEST_ACCOUNT);

		const customTxId = "tx_persist_assertion";
		const op = makeCheckpointOp(
			{ blockNum: ALIGNED_BLOCK, stateRoot: VALID_STATE_ROOT },
			{ txId: customTxId },
		);

		await handleNodeStateCheckpoint(op, sql);

		const [row] = await sql`
			SELECT account, block_num, state_root, tx_id
			FROM l2_node_checkpoints
			WHERE tx_id = ${customTxId}
		`;
		expect(row).toBeDefined();
		expect(String(row!.account)).toBe(TEST_ACCOUNT);
		expect(Number(row!.block_num)).toBe(ALIGNED_BLOCK);
		expect(String(row!.state_root)).toBe(VALID_STATE_ROOT);
		expect(String(row!.tx_id)).toBe(customTxId);
	});
});
