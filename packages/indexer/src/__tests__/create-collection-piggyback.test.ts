import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { withTransaction, sql } from "@/db/client.ts";
import { routeOperation } from "@/processor/action-router.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	ACTION_CREATE_COLLECTION,
	PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	INSTANCE_FEE_PER_N,
	MAX_INSTANCES_PER_COLLECTION,
	generateDeterministicCollectionId,
	generateOriginDna,
} from "@/protocol/index.ts";
import { config } from "@/config.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";

async function cleanDb(): Promise<void> {
	await sql`DELETE FROM collections`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
	await sql`DELETE FROM l2_nodes`;
}

async function seedNodeForTests(): Promise<void> {
	await seedActiveSettlementNode(config.hiveAccount);
}

async function buildCreateCollectionOp(args: {
	canonicalId: string;
	name: string;
	symbol: string;
	creator: string;
	memo: string;
	operationId: string;
	maxInstances?: number;
}): Promise<ParsedOperation> {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const originDna = await generateOriginDna(args.canonicalId);
	return {
		blockNum: 1,
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
		txId: `tx_piggy_${args.operationId}`,
		operationId: args.operationId,
		signer: config.hiveAccount,
		authLevel: "active",
		action: ACTION_CREATE_COLLECTION,
		data: {
			id: args.canonicalId,
			name: args.name,
			symbol: args.symbol,
			originDna,
			totalPotential: 5,
			maxInstances: args.maxInstances ?? 0,
			metadata: { description: "piggy test", image: "https://example.com/x.png" },
			rules: { transferable: true, burnable: false, royaltyPct: 0 },
		},
		pairedTransfers: [
			{ from: args.creator, to: config.hiveAccount, amount: feeAmount, currency: "HBD", memo: args.memo },
		],
	};
}

describe("create_collection — memo binding prevents piggyback", () => {
	beforeEach(async () => {
		await cleanDb();
		await seedNodeForTests();
	});
	afterEach(cleanDb);

	test("transfer without FEE-COL memo is rejected by router", async () => {
		const canonicalId = await generateDeterministicCollectionId("alice", "PiggyA", "PIGA");
		const op = await buildCreateCollectionOp({
			canonicalId,
			name: "PiggyA",
			symbol: "PIGA",
			creator: "alice",
			memo: "", // piggyback: missing protocol memo
			operationId: "op_piggy_bad",
		});
		await withTransaction(async (txn) => {
			const ok = await routeOperation(op, txn);
			expect(ok).toBe(false);
		});
		// Must have landed in invalid_operations.
		const invalid = await sql`SELECT reason FROM invalid_operations WHERE operation_id = ${"op_piggy_bad"}`;
		expect(invalid).toHaveLength(1);
		expect(String(invalid[0]?.reason)).toMatch(/memo|FEE-COL/i);
	});

	test("transfer with correct FEE-COL memo is accepted", async () => {
		const canonicalId = await generateDeterministicCollectionId("alice", "PiggyB", "PIGB");
		const op = await buildCreateCollectionOp({
			canonicalId,
			name: "PiggyB",
			symbol: "PIGB",
			creator: "alice",
			memo: `NFTLox FEE-COL:${canonicalId}`,
			operationId: "op_piggy_good",
		});
		await withTransaction(async (txn) => {
			const ok = await routeOperation(op, txn);
			expect(ok).toBe(true);
		});
		const rows = await sql`SELECT id, creator FROM collections WHERE id = ${canonicalId}`;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.creator).toBe("alice");
	});

	test("transfer whose memo targets a different collectionId is rejected", async () => {
		const canonicalId = await generateDeterministicCollectionId("alice", "PiggyC", "PIGC");
		const op = await buildCreateCollectionOp({
			canonicalId,
			name: "PiggyC",
			symbol: "PIGC",
			creator: "alice",
			memo: `NFTLox FEE-COL:some_other_id`,
			operationId: "op_piggy_mismatch",
		});
		await withTransaction(async (txn) => {
			const ok = await routeOperation(op, txn);
			expect(ok).toBe(false);
		});
		const invalid = await sql`SELECT reason FROM invalid_operations WHERE operation_id = ${"op_piggy_mismatch"}`;
		expect(invalid).toHaveLength(1);
	});
});

describe("create_collection — maxInstances protocol cap", () => {
	beforeEach(async () => {
		await cleanDb();
		await seedNodeForTests();
	});
	afterEach(cleanDb);

	test(`maxInstances above ${MAX_INSTANCES_PER_COLLECTION} is rejected`, async () => {
		// Use a value that stays on the INSTANCE_FEE_PER_N multiple so the cap
		// check is exercised before the modulo check (assertion target is the
		// cap, not the granularity rule).
		const oversized = MAX_INSTANCES_PER_COLLECTION + INSTANCE_FEE_PER_N;
		const canonicalId = await generateDeterministicCollectionId("alice", "CapOver", "CAPOV");
		const op = await buildCreateCollectionOp({
			canonicalId,
			name: "CapOver",
			symbol: "CAPOV",
			creator: "alice",
			memo: `NFTLox FEE-COL:${canonicalId}`,
			operationId: "op_max_inst_over",
			maxInstances: oversized,
		});
		await withTransaction(async (txn) => {
			const ok = await routeOperation(op, txn);
			expect(ok).toBe(false);
		});
		const invalid = await sql`SELECT reason FROM invalid_operations WHERE operation_id = ${"op_max_inst_over"}`;
		expect(invalid).toHaveLength(1);
		expect(String(invalid[0]?.reason)).toMatch(/maxInstances.*(cap|exceeds)/i);
		const rows = await sql`SELECT id FROM collections WHERE id = ${canonicalId}`;
		expect(rows).toHaveLength(0);
	});

	test(`maxInstances exactly at ${MAX_INSTANCES_PER_COLLECTION} is accepted`, async () => {
		const canonicalId = await generateDeterministicCollectionId("alice", "CapEdge", "CAPED");
		const op = await buildCreateCollectionOp({
			canonicalId,
			name: "CapEdge",
			symbol: "CAPED",
			creator: "alice",
			memo: `NFTLox FEE-COL:${canonicalId}`,
			operationId: "op_max_inst_edge",
			maxInstances: MAX_INSTANCES_PER_COLLECTION,
		});
		await withTransaction(async (txn) => {
			const ok = await routeOperation(op, txn);
			expect(ok).toBe(true);
		});
		const rows = await sql`SELECT id, max_instances FROM collections WHERE id = ${canonicalId}`;
		expect(rows).toHaveLength(1);
		expect(Number(rows[0]?.max_instances)).toBe(MAX_INSTANCES_PER_COLLECTION);
	});
});
