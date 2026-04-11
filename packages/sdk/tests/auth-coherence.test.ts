import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
	ALL_ACTIONS,
	ACTION_AUTH_LEVEL,
	makePayload,
	toHiveOperation,
	type ProtocolAction,
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
} from "../src/index";
import {
	ACTION_AUTH_LEVEL as INDEXER_ACTION_AUTH_LEVEL,
} from "../../indexer/src/protocol/auth.ts";
import {
	ALL_ACTIONS as INDEXER_ALL_ACTIONS,
} from "../../indexer/src/protocol/constants.ts";

// ============ STATIC: no builder may hardcode auth literals ============
//
// Every build* function must route through the canonical helper
// (toHiveOperation or a create*Operation factory). This guard detects drift
// if anyone re-introduces a raw custom_json block in a builder file.

describe("Builders never hardcode auth fields", () => {
	const buildersDir = join(import.meta.dir, "..", "src", "builders");
	const files = readdirSync(buildersDir)
		.filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "helpers.ts" && f !== "seed-availability.ts");

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

// ============ RUNTIME: toHiveOperation respects ACTION_AUTH_LEVEL ============

describe("toHiveOperation emits auth fields from ACTION_AUTH_LEVEL", () => {
	for (const action of ALL_ACTIONS) {
		const level = ACTION_AUTH_LEVEL[action as ProtocolAction];
		test(`${action} → ${level}`, () => {
			const payload = { protocol: "nftlox", version: "0.1", action, data: {} } as const;
			const op = toHiveOperation(payload, "alice");
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
		const payload = {
			protocol: "nftlox",
			version: "0.1",
			action: "pack_buy" as ProtocolAction,
			data: { packId: "pack_1", quantity: 1 },
		} as const;

		expect(() => toHiveOperation(payload, "alice")).toThrow("Unsupported protocol action: pack_buy");
	});

	test("makePayload rejects removed pack actions", () => {
		expect(() => makePayload("pack_buy" as ProtocolAction, {})).toThrow("Unsupported protocol action: pack_buy");
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

describe("SDK follows the indexer action/auth catalog", () => {
	test("action set and auth levels match the indexer", () => {
		expect([...ALL_ACTIONS]).toEqual([...INDEXER_ALL_ACTIONS]);
		expect(ACTION_AUTH_LEVEL).toEqual(INDEXER_ACTION_AUTH_LEVEL);
	});
});

// ============ END-TO-END: every builder emits auth fields consistent with the map ============
//
// For each builder, parse its emitted operation.json.action and verify the
// custom_json auth fields match ACTION_AUTH_LEVEL[action]. Covers the full
// request-parse-emit pipeline, not just the helper in isolation.

function assertAuthCoherent(
	operation: ReadonlyArray<unknown> | undefined,
	expectedSigner: string,
) {
	expect(operation).toBeDefined();
	const [kind, body] = operation as [string, { required_auths: string[]; required_posting_auths: string[]; json: string }];
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
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildTransfer", async () => {
		const r = await buildTransfer({ nftId: "nft_1", from: "alice", to: "bob" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildList", async () => {
		const r = await buildList({
			nftId: "nft_1",
			price: { amount: "10.000", currency: "HIVE" },
			owner: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildUnlist", async () => {
		const r = await buildUnlist({ nftId: "nft_1", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildBuy — active key, signer is the node account (multisig envelope)", () => {
		const r = buildBuy({
			nftId: "nft_1",
			listingId: "list_1",
			listTxId: "a".repeat(40),
			txId: "b".repeat(40),
			buyer: "alice",
			seller: "bob",
			nodeAccount: "nftlox-node",
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
		// buildBuy emits hiveOperations (transfers + custom_json), not a single `operation` field.
		const customJsonOp = r.hiveOperations?.find(op => op[0] === "custom_json");
		assertAuthCoherent(customJsonOp, "nftlox-node");
	});

	test("buildBulkDistribute", () => {
		const r = buildBulkDistribute({
			items: [{ seedId: "seed_1", quantity: 1, seedTxId: "a".repeat(40) }],
			signer: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildSetData", () => {
		const r = buildSetData({ nftId: "nft_1", instanceDna: "dna_1", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildNftLend", () => {
		const r = buildNftLend({ instanceId: "nft_1", borrower: "bob", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildNftReturn", () => {
		const r = buildNftReturn({ instanceId: "nft_1", owner: "alice" });
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildNftApprove", () => {
		const r = buildNftApprove({
			spender: "bob",
			instanceId: "nft_1",
			approved: true,
			owner: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildNftApproveAll", () => {
		const r = buildNftApproveAll({
			spender: "bob",
			collectionId: "col_1",
			approved: true,
			owner: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildNftTransferFrom", () => {
		const r = buildNftTransferFrom({
			from: "alice",
			to: "bob",
			instanceId: "nft_1",
			operator: "charlie",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "charlie");
	});

	test("buildDataOperatorApprove", () => {
		const r = buildDataOperatorApprove({
			collectionId: "col_1",
			operator: "bob",
			approved: true,
			creator: "alice",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "alice");
	});

	test("buildNodeRegister", () => {
		const r = buildNodeRegister({
			endpoint: "https://node.example.com",
			publicKey: "STM6MRyAjQq8ud7hVNYcfnVPJqcVpscN5SoFMugdoJ2M6YB8Wf7b2",
			nodeAccount: "indexer-node",
		});
		if (!r.success) throw new Error("build failed");
		assertAuthCoherent(r.operation, "indexer-node");
	});
});
