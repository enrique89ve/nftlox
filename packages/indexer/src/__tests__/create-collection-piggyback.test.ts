import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { withTransaction, sql } from "@/db/client.ts";
import { routeOperation } from "@/processor/action-router.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	ACTION_CREATE_COLLECTION,
	PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	generateDeterministicCollectionId,
} from "@/protocol/index.ts";
import { config } from "@/config.ts";

async function cleanDb(): Promise<void> {
	await sql`DELETE FROM collections`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
}

function buildCreateCollectionOp(args: {
	canonicalId: string;
	name: string;
	symbol: string;
	creator: string;
	memo: string;
	operationId: string;
}): ParsedOperation {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
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
			totalPotential: 5,
			maxInstances: 0,
			metadata: { description: "piggy test", image: "https://example.com/x.png" },
			rules: { transferable: true, burnable: false, royaltyPct: 0 },
		},
		pairedTransfers: [
			{ from: args.creator, to: config.hiveAccount, amount: feeAmount, currency: "HBD", memo: args.memo },
		],
	};
}

describe("create_collection — memo binding prevents piggyback", () => {
	beforeEach(cleanDb);
	afterEach(cleanDb);

	test("transfer without FEE-COL memo is rejected by router", async () => {
		const canonicalId = await generateDeterministicCollectionId("alice", "PiggyA", "PIGA");
		const op = buildCreateCollectionOp({
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
		const op = buildCreateCollectionOp({
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
		const op = buildCreateCollectionOp({
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
