import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
	ALL_ACTIONS,
	ACTION_AUTH_LEVEL,
	createPayload,
	createHiveOperation,
	type ProtocolAction,
	type HiveOperation,
	buildBurn,
	buildTransfer,
	buildList,
	buildUnlist,
	buildBuy,
	buildBulkDistribute,
	buildSetData,
	buildNftLend,
	buildNftReturn,
	buildNftApprove,
	buildNftApproveAll,
	buildNftTransferFrom,
	buildDataOperatorApprove,
	buildNodeRegister,
	buildNodeHeartbeat,
} from "../src/index";

// ============ STATIC: no builder may hardcode auth literals ============
//
// Every build* function must route through the canonical helper
// (createHiveOperation). This guard detects drift if anyone re-introduces a raw
// custom_json block in a builder file.

describe("Builders never hardcode auth fields", () => {
	const buildersDir = join(import.meta.dir, "..", "src", "builders");
	const files = readdirSync(buildersDir)
		.filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "helpers.ts" && f !== "seed-availability.ts" && f !== "types.ts");

	for (const file of files) {
		test(`${file} contains no raw custom_json / required_auths / getProtocolId`, () => {
			const source = readFileSync(join(buildersDir, file), "utf8");
			expect(source).not.toContain("\"custom_json\"");
			expect(source).not.toContain("required_auths");
			expect(source).not.toContain("required_posting_auths");
			expect(source).not.toContain("getProtocolId");
		});
	}
});

// ============ RUNTIME: createHiveOperation respects ACTION_AUTH_LEVEL ============

describe("createHiveOperation emits auth fields from ACTION_AUTH_LEVEL", () => {
	for (const action of ALL_ACTIONS) {
		const level = ACTION_AUTH_LEVEL[action as ProtocolAction];
		test(`${action} → ${level}`, () => {
			const payload = createPayload(action, {});
			const op = createHiveOperation(payload, "alice");
			if (level === "active") {
				expect(op[1].required_auths).toEqual(["alice"]);
				expect(op[1].required_posting_auths).toEqual([]);
			} else {
				expect(op[1].required_auths).toEqual([]);
				expect(op[1].required_posting_auths).toEqual(["alice"]);
			}
		});
	}

	test("rejects removed pack actions instead of falling back to posting auth", () => {
		expect(() => createPayload("pack_buy" as ProtocolAction, { packId: "pack_1", quantity: 1 }))
			.toThrow("Unsupported protocol action: pack_buy");
	});
});

describe("Operations catalog documents the canonical action set", () => {
	function extractCatalogActions(markdown: string): string[] {
		return [...markdown.matchAll(/^\| \d+ \| `([^`]+)` \|/gm)]
			.map(match => match[1]!)
			.filter(action => action !== "Action");
	}

	test("summary table exactly matches ALL_ACTIONS", () => {
		const catalog = readFileSync(join(import.meta.dir, "..", "OPERATIONS.md"), "utf8");
		expect(extractCatalogActions(catalog)).toEqual([...ALL_ACTIONS]);
	});
});

// ============ END-TO-END: every builder emits auth fields consistent with the map ============
//
// For each builder, parse its emitted operation.json.action and verify the
// custom_json auth fields match ACTION_AUTH_LEVEL[action]. Covers the full
// request-parse-emit pipeline, not just the helper in isolation.

function assertAuthCoherent(
	operation: HiveOperation | undefined,
	expectedSigner: string,
) {
	expect(operation).toBeDefined();
	const [kind, body] = operation as HiveOperation;
	expect(kind).toBe("custom_json");
	const parsed = JSON.parse(body.json) as { action: string };
	const level = ACTION_AUTH_LEVEL[parsed.action as ProtocolAction];
	expect(level).toBeDefined();
	if (level === "active") {
		expect(body.required_auths).toEqual([expectedSigner]);
		expect(body.required_posting_auths).toEqual([]);
	} else {
		expect(body.required_auths).toEqual([]);
		expect(body.required_posting_auths).toEqual([expectedSigner]);
	}
}

describe("Builders emit auth fields that match ACTION_AUTH_LEVEL", () => {
	test("buildBurn (was previously hardcoded active — regression guard)", () => {
		const r = buildBurn({ nftId: "nft_1", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildTransfer", async () => {
		const r = await buildTransfer({ nftId: "nft_1", from: "alice", to: "bob" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildList", async () => {
		const r = await buildList({
			nftId: "nft_1",
			price: { amount: "10.000", currency: "HIVE" },
			owner: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildUnlist", async () => {
		const r = await buildUnlist({ nftId: "nft_1", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildBuy — active key, buyer signs transfers and node signs custom_json", () => {
		const r = buildBuy({
			nftId: "nft_1",
			listingId: "list_1",
			listTxId: "a".repeat(40),
			txId: "b".repeat(40),
			buyer: "alice",
			seller: "bob",
			paymentSplit: {
				sellerAmount: 9.5,
				royaltyAmount: 0.5,
				royaltyRecipient: "creator",
				feeAmount: 0,
				feeAccount: "fee-account",
				totalPrice: 10,
				currency: "HIVE",
			},
		});
		if (!r.success) throw new Error("build failed");
		// buildBuy emits [transfers..., custom_json]; buyer signs transfers, node signs custom_json.
		const customJsonOp = r.operations.find((op): op is HiveOperation => op[0] === "custom_json");
		assertAuthCoherent(customJsonOp, "fee-account");
		expect(r.signer).toBe("alice");
		expect(r.coSigners).toEqual([{
			op: 2,
			account: "fee-account",
			keyType: "Active",
			via: "multisig",
		}]);
	});

	test("buildBulkDistribute", () => {
		const r = buildBulkDistribute({
			items: [{ seedId: "seed_1", quantity: 1, seedTxId: "a".repeat(40) }],
			signer: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildSetData", () => {
		const r = buildSetData({ nftId: "nft_1", instanceDna: "dna_1", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildNftLend", () => {
		const r = buildNftLend({ instanceId: "nft_1", borrower: "bob", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildNftReturn", () => {
		const r = buildNftReturn({ instanceId: "nft_1", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildNftApprove", () => {
		const r = buildNftApprove({
			spender: "bob",
			instanceId: "nft_1",
			approved: true,
			owner: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildNftApproveAll", () => {
		const r = buildNftApproveAll({
			spender: "bob",
			collectionId: "col_1",
			approved: true,
			owner: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildNftTransferFrom", () => {
		const r = buildNftTransferFrom({
			from: "alice",
			to: "bob",
			instanceId: "nft_1",
			operator: "charlie",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "charlie");
	});

	test("buildDataOperatorApprove", () => {
		const r = buildDataOperatorApprove({
			collectionId: "col_1",
			operator: "bob",
			approved: true,
			creator: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "alice");
	});

	test("buildNodeRegister", () => {
		const r = buildNodeRegister({
			endpoint: "https://node.example.com",
			publicKey: "STM6MRyAjQq8ud7hVNYcfnVPJqcVpscN5SoFMugdoJ2M6YB8Wf7b2",
			nodeAccount: "indexer-node",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "indexer-node");
	});

	test("buildNodeHeartbeat", () => {
		const r = buildNodeHeartbeat({
			blockNum: 123456,
			stateRoot: `sha256:${"a".repeat(64)}`,
			indexerVersion: "0.5.3",
			nodeAccount: "indexer-node",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operations[0] as HiveOperation, "indexer-node");

		const [, body] = r.operations[0] as HiveOperation;
		const parsed = JSON.parse(body.json) as {
			action: string;
			data: { blockNum: number; stateRoot: string; indexerVersion: string };
		};
		expect(parsed.action).toBe("node_heartbeat");
		expect(parsed.data.blockNum).toBe(123456);
		expect(parsed.data.stateRoot).toBe(`sha256:${"a".repeat(64)}`);
		expect(parsed.data.indexerVersion).toBe("0.5.3");
	});

	test("buildNodeHeartbeat rejects malformed stateRoot", () => {
		const r = buildNodeHeartbeat({
			blockNum: 100,
			stateRoot: "nothex:zzz",
			indexerVersion: "0.5.3",
			nodeAccount: "indexer-node",
		});
		expect(r.success).toBe(false);
	});

	test("buildNodeHeartbeat rejects negative blockNum", () => {
		const r = buildNodeHeartbeat({
			blockNum: -1,
			stateRoot: `sha256:${"b".repeat(64)}`,
			indexerVersion: "0.5.3",
			nodeAccount: "indexer-node",
		});
		expect(r.success).toBe(false);
	});
});
