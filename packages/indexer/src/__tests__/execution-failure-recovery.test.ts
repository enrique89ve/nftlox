import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import { routeOperationDetailed } from "@/processor/action-router.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	getAuthLevel,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateOriginDna,
} from "@/protocol/index.ts";
import { config } from "@/config.ts";

const COLLECTION_NAME = "ExecutionFailureRecovery";
const COLLECTION_SYMBOL = "EXFAIL";
const ART_A = "failure-a";
const ART_B = "failure-b";

let collectionId: string;
let seedA: string;
let seedB: string;

function makeOp(
	action: string,
	data: Record<string, unknown>,
	overrides: Partial<Pick<ParsedOperation, "operationId" | "txId" | "signer" | "blockNum">> = {},
): ParsedOperation {
	return {
		blockNum: overrides.blockNum ?? 90000100,
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
		txId: overrides.txId ?? `tx-recovery-${action}-${Math.random()}`,
		operationId: overrides.operationId ?? `op-recovery-${action}-${Math.random()}`,
		signer: overrides.signer ?? "alice",
		authLevel: getAuthLevel(action),
		action: action as ParsedOperation["action"],
		data,
	};
}

async function cleanDb(): Promise<void> {
	await sql`TRUNCATE assets, owner_asset_counts, collection_stats, collections,
		invalid_operations, confirmed_operations, orphaned_buys RESTART IDENTITY CASCADE`;
}

async function seedFixture(): Promise<void> {
	const feeAmount = Number(PROTOCOL_COLLECTION_FEE_HBD);
	const createOp = makeOp(ACTION_CREATE_COLLECTION, {
		id: collectionId,
		name: COLLECTION_NAME,
		symbol: COLLECTION_SYMBOL,
		originDna: await generateOriginDna(collectionId),
		totalPotential: 10,
		maxInstances: 0,
		metadata: { description: "execution failure test", image: "https://example.com/recovery.png" },
		rules: { transferable: true, burnable: false, royaltyPct: 0 },
	}, { signer: config.hiveAccount, operationId: "op-recovery-create" });
	createOp.pairedTransfers = [{
		from: "alice",
		to: config.hiveAccount,
		amount: feeAmount,
		currency: "HBD",
		memo: `NFTLox FEE-COL:${collectionId}`,
	}];
	createOp.payment = {
		kind: "fixed",
		payer: "alice",
		amount: feeAmount,
		currency: "HBD",
		consumedIndices: [0],
	};

	await withTransaction(async (txn) => {
		await handleCreateCollection(createOp, txn);
		for (const [artId, id, operationId] of [
			[ART_A, seedA, "op-recovery-mint-a"],
			[ART_B, seedB, "op-recovery-mint-b"],
		] as const) {
			await handleMint(makeOp(ACTION_MINT, {
				id,
				artId,
				collectionId,
				edition: 1,
				owner: "alice",
				assetType: "seed",
				maxSupply: 1,
			}, { operationId }), txn);
		}
	});
}

describe("execution failure recovery with PostgreSQL", () => {
	beforeEach(async () => {
		collectionId = await generateDeterministicCollectionId("alice", COLLECTION_NAME, COLLECTION_SYMBOL);
		seedA = await generateDeterministicSeedId(collectionId, ART_A);
		seedB = await generateDeterministicSeedId(collectionId, ART_B);
		await cleanDb();
		await seedFixture();
	});

	afterEach(cleanDb);

	it("rolls back the whole batch on a real lock timeout, then retries exactly once", async () => {
		const firstTransfer = makeOp(ACTION_TRANSFER, { assetId: seedA, to: "bob" }, {
			operationId: "op-recovery-transfer-a",
			txId: "a".repeat(40),
		});
		const blockedTransfer = makeOp(ACTION_TRANSFER, { assetId: seedB, to: "bob" }, {
			operationId: "op-recovery-transfer-b",
			txId: "b".repeat(40),
		});

		let unlock!: () => void;
		let signalLocked!: () => void;
		const release = new Promise<void>((resolve) => { unlock = resolve; });
		const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
		const lockerPromise = sql.begin(async (txn) => {
			const lockQuery = txn as unknown as typeof sql;
			await lockQuery`SELECT id FROM assets WHERE id = ${seedB} FOR UPDATE`;
			signalLocked();
			await release;
		});

		try {
			await locked;
			const beforeRoot = (await sql`SELECT state_root FROM state_meta WHERE id = 1`)[0]!.state_root;

			const runBlockedBatch = withTransaction(async (txn) => {
				await txn`SET LOCAL lock_timeout = '50ms'`;
				const firstResult = await routeOperationDetailed(firstTransfer, txn);
				expect(firstResult.kind).toBe("applied");
				const blockedResult = await routeOperationDetailed(blockedTransfer, txn);
				expect(blockedResult.kind).toBe("fatal");
				if (blockedResult.kind !== "fatal") throw new Error("Expected fatal lock timeout");
				expect(blockedResult.transient).toBe(true);
				expect((blockedResult.cause as { readonly code?: string }).code).toBe("55P03");
				throw new Error(blockedResult.reason, { cause: blockedResult.cause });
			});
			await expect(runBlockedBatch).rejects.toThrow();

			const [afterRollbackA, afterRollbackB] = await sql`
				SELECT id, owner FROM assets WHERE id IN (${seedA}, ${seedB}) ORDER BY id
			`;
			expect(afterRollbackA?.owner).toBe("alice");
			expect(afterRollbackB?.owner).toBe("alice");
			expect((await sql`SELECT state_root FROM state_meta WHERE id = 1`)[0]!.state_root).toEqual(beforeRoot);
			expect(await sql`SELECT 1 FROM confirmed_operations WHERE operation_id IN (${firstTransfer.operationId}, ${blockedTransfer.operationId})`).toHaveLength(0);
			expect(await sql`SELECT 1 FROM invalid_operations WHERE operation_id IN (${firstTransfer.operationId}, ${blockedTransfer.operationId})`).toHaveLength(0);

			unlock();
			await lockerPromise;

			await withTransaction(async (txn) => {
				expect((await routeOperationDetailed(firstTransfer, txn)).kind).toBe("applied");
				expect((await routeOperationDetailed(blockedTransfer, txn)).kind).toBe("applied");
			});

			// A replay after both durable confirmations is an idempotent no-op.
			await withTransaction(async (txn) => {
				expect((await routeOperationDetailed(firstTransfer, txn)).kind).toBe("applied");
				expect((await routeOperationDetailed(blockedTransfer, txn)).kind).toBe("applied");
			});
			const [confirmationCount] = await sql`SELECT COUNT(*)::int AS count FROM confirmed_operations WHERE operation_id IN (${firstTransfer.operationId}, ${blockedTransfer.operationId})`;
			expect(confirmationCount?.count).toBe(2);
			expect((await sql`SELECT owner FROM assets WHERE id = ${seedA}`)[0]!.owner).toBe("bob");
			expect((await sql`SELECT owner FROM assets WHERE id = ${seedB}`)[0]!.owner).toBe("bob");
		} finally {
			unlock();
			await lockerPromise;
		}
	});
});
