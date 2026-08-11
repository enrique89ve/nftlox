import { describe, expect, test } from "bun:test";
import {
	ACTION_BULK_DISTRIBUTE,
	ACTION_MINT,
	ACTION_NFT_LEND,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_TRANSFER,
	getAuthLevel,
} from "@/protocol/index.ts";
import type { ParsedOperation } from "../scanner/operation-parser.ts";
import {
	buildAccountValidationPlan,
	prepareAccountValidation,
} from "../processor/account-validation.ts";

function makeOperation(
	action: string,
	data: Record<string, unknown>,
	signer = "alice",
	operationId = "op-1",
): ParsedOperation {
	return {
		blockNum: 100,
		timestamp: "2026-01-01T00:00:00.000Z",
		txId: "a".repeat(40),
		operationId,
		signer,
		authLevel: getAuthLevel(action),
		action: action as ParsedOperation["action"],
		version: "0.11.0",
		data,
	};
}

const client = {
	lookup: async (accounts: readonly string[]) => ({
		requested: accounts,
		accounts: new Map(
			accounts
				.filter((account) => account === "bob")
				.map((account) => [account, { name: account, createdAt: "2020-01-01T00:00:00.000Z" }]),
		),
		missing: new Set(accounts.filter((account) => account !== "bob")),
		attemptedEndpoints: ["test"],
	}),
};

describe("account validation preparation", () => {
	test("rejects an empty transfer recipient before any account lookup", () => {
		const op = makeOperation(ACTION_TRANSFER, { to: "" });
		const plan = buildAccountValidationPlan([op]);

		expect(plan.accounts).toEqual([]);
		expect(plan.targets.get(op.operationId)).toEqual({
			kind: "rejected",
			reason: "Missing or invalid to: expected a non-empty Hive account name",
		});
	});

	test("does not query burn or explicit self-recipient operations", () => {
		const burn = makeOperation(ACTION_TRANSFER, { to: "null" }, "alice", "op-burn");
		const selfBulk = makeOperation(ACTION_BULK_DISTRIBUTE, { to: "alice" }, "alice", "op-bulk");
		const selfMint = makeOperation(ACTION_MINT, { owner: "alice" }, "alice", "op-mint");
		const plan = buildAccountValidationPlan([burn, selfBulk, selfMint]);

		expect(plan.accounts).toEqual([]);
		expect([...plan.targets.values()]).toEqual([
			{ kind: "not-required" },
			{ kind: "not-required" },
			{ kind: "not-required" },
		]);
	});

	test("groups only distinct external recipients", () => {
		const ops = [
			makeOperation(ACTION_TRANSFER, { to: "bob" }, "alice", "op-transfer"),
			makeOperation(ACTION_BULK_DISTRIBUTE, { to: "bob" }, "alice", "op-bulk"),
			makeOperation(ACTION_MINT, { owner: "charlie" }, "alice", "op-mint"),
		];
		const plan = buildAccountValidationPlan(ops);

		expect(plan.accounts).toEqual(["bob", "charlie"]);
	});

	test("groups nft_lend.borrower and nft_transfer_from.to recipients", () => {
		const lend = makeOperation(ACTION_NFT_LEND, { borrower: "bob" }, "alice", "op-lend");
		const transferFrom = makeOperation(
			ACTION_NFT_TRANSFER_FROM,
			{ from: "alice", to: "charlie" },
			"spender",
			"op-transfer-from",
		);

		const plan = buildAccountValidationPlan([lend, transferFrom]);

		expect(plan.accounts).toEqual(["bob", "charlie"]);
	});

	test("maps missing accounts to rejected operations", async () => {
		const valid = makeOperation(ACTION_TRANSFER, { to: "bob" }, "alice", "op-valid");
		const missing = makeOperation(ACTION_BULK_DISTRIBUTE, { to: "charlie" }, "alice", "op-missing");
		const decisions = await prepareAccountValidation([valid, missing], client);

		expect(decisions.get(valid.operationId)).toEqual({ kind: "accepted", account: "bob" });
		expect(decisions.get(missing.operationId)).toEqual({
			kind: "rejected",
			reason: "Hive account does not exist: charlie",
		});
	});

	test("rejects an account created after the operation block timestamp", async () => {
		const lateAccountClient = {
			lookup: async (accounts: readonly string[]) => ({
				requested: accounts,
				accounts: new Map([
					["bob", { name: "bob", createdAt: "2026-02-01T00:00:00.000Z" }],
				]),
				missing: new Set<string>(),
				attemptedEndpoints: ["test"],
			}),
		};
		const op = makeOperation(ACTION_TRANSFER, { to: "bob" });

		const decisions = await prepareAccountValidation([op], lateAccountClient);

		expect(decisions.get(op.operationId)).toEqual({
			kind: "rejected",
			reason: "Hive account bob did not exist before operation timestamp 2026-01-01T00:00:00.000Z",
		});
	});

	test("rejects nft_lend when borrower creation equals the operation timestamp", async () => {
		const sameBlockClient = {
			lookup: async (accounts: readonly string[]) => ({
				requested: accounts,
				accounts: new Map([
					["bob", { name: "bob", createdAt: "2026-01-01T00:00:00.000Z" }],
				]),
				missing: new Set<string>(),
				attemptedEndpoints: ["test"],
			}),
		};
		const op = makeOperation(ACTION_NFT_LEND, { borrower: "bob" });

		const decisions = await prepareAccountValidation([op], sameBlockClient);

		expect(decisions.get(op.operationId)?.kind).toBe("rejected");
	});

	test("compares one grouped account independently against each operation timestamp", async () => {
		let lookupAccounts: readonly string[] = [];
		const datedClient = {
			lookup: async (accounts: readonly string[]) => {
				lookupAccounts = accounts;
				return {
					requested: accounts,
					accounts: new Map([
						["bob", { name: "bob", createdAt: "2025-01-01T00:00:00.000Z" }],
					]),
					missing: new Set<string>(),
					attemptedEndpoints: ["test"],
				};
			},
		};
		const oldOp = {
			...makeOperation(ACTION_TRANSFER, { to: "bob" }, "alice", "op-old"),
			timestamp: "2024-01-01T00:00:00.000Z",
		};
		const newOp = {
			...makeOperation(ACTION_TRANSFER, { to: "bob" }, "alice", "op-new"),
			timestamp: "2026-01-01T00:00:00.000Z",
		};

		const decisions = await prepareAccountValidation([oldOp, newOp], datedClient);

		expect(lookupAccounts).toEqual(["bob"]);
		expect(decisions.get(oldOp.operationId)?.kind).toBe("rejected");
		expect(decisions.get(newOp.operationId)).toEqual({ kind: "accepted", account: "bob" });
	});

	test("rejects duplicate operation IDs before performing a lookup", async () => {
		let lookups = 0;
		const duplicateClient = {
			lookup: async () => {
				lookups++;
				return {
					requested: [],
					accounts: new Map(),
					missing: new Set<string>(),
					attemptedEndpoints: [],
				};
			},
		};
		const first = makeOperation(ACTION_TRANSFER, { to: "bob" }, "alice", "duplicate");
		const second = makeOperation(ACTION_MINT, { owner: "charlie" }, "alice", "duplicate");

		await expect(prepareAccountValidation([first, second], duplicateClient)).rejects.toThrow(
			"Duplicate operationId in account validation plan: duplicate",
		);
		expect(lookups).toBe(0);
	});

	test("rejects an auth mismatch without performing an account lookup", async () => {
		let lookups = 0;
		const noLookupClient = {
			lookup: async () => {
				lookups++;
				throw new Error("lookup should not run");
			},
		};
		const op = {
			...makeOperation(ACTION_TRANSFER, { to: "bob" }),
			authLevel: "posting" as const,
		};

		const decisions = await prepareAccountValidation([op], noLookupClient);

		expect(lookups).toBe(0);
		expect(decisions.get(op.operationId)).toEqual({
			kind: "rejected",
			reason: "Action 'transfer' requires active key authority, got posting",
		});
	});

	test("treats an omitted optional recipient as the signer without an RPC lookup", async () => {
		let lookups = 0;
		const noLookupClient = {
			lookup: async () => {
				lookups++;
				return {
					requested: [],
					accounts: new Map(),
					missing: new Set<string>(),
					attemptedEndpoints: [],
				};
			},
		};
		const op = makeOperation(ACTION_BULK_DISTRIBUTE, { items: [] });

		const decisions = await prepareAccountValidation([op], noLookupClient);

		expect(lookups).toBe(0);
		expect(decisions.get(op.operationId)).toEqual({ kind: "not-required" });
	});
});
