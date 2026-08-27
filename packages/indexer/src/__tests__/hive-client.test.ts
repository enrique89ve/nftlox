import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import type { ConsensusHead } from "../scanner/head-consensus.ts";
import { selectConsensusSample } from "../scanner/head-consensus.ts";

process.env.INDEXER_ROLE = "sync";
const EP_A = "https://hafah-a.test";
const EP_B = "https://hafah-b.test";
process.env.HIVE_ENDPOINTS = `${EP_A},${EP_B}`;

const originalFetch = globalThis.fetch;
const {
	fetchRangeFromEndpoint,
	fetchRangeWithFailover,
	getCustomJsonInRange,
	resetHafAHHealth,
} = await import("../scanner/hive-client.ts");

afterEach(() => {
	globalThis.fetch = originalFetch;
});

beforeEach(() => {
	resetHafAHHealth();
});

function sample(headBlock: number, irreversibleBlock: number): ConsensusHead {
	return { headBlock, irreversibleBlock };
}

describe("selectConsensusSample", () => {
	test("returns the only available sample", () => {
		expect(selectConsensusSample([sample(120, 100)], head => head)).toEqual({
			headBlock: 120,
			irreversibleBlock: 100,
		});
	});

	test("chooses the lower irreversible block when two endpoints disagree", () => {
		expect(selectConsensusSample([
			sample(121, 100),
			sample(125, 104),
		], head => head)).toEqual({
			headBlock: 121,
			irreversibleBlock: 100,
		});
	});

	test("rejects a single high outlier with three endpoints", () => {
		expect(selectConsensusSample([
			sample(130, 100),
			sample(131, 101),
			sample(140, 140),
		], head => head)).toEqual({
			headBlock: 131,
			irreversibleBlock: 101,
		});
	});
});

describe("getCustomJsonInRange — HafAH envelope validation", () => {
	test("rejects a 200 response that omits the ops array", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({
			error: "temporary backend error",
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;

		await expect(getCustomJsonInRange(100, 120, "nftlox_testnet"))
			.rejects
			.toThrow("Invalid HafAH response");
	});

	test("accepts an explicit empty final page", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({
			ops: [],
			next_block_range_begin: null,
			next_operation_begin: null,
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;

		await expect(getCustomJsonInRange(100, 120, "nftlox_testnet"))
			.resolves
			.toEqual([]);
	});
});

type PageSpec = Readonly<{
	block: number;
	operationId: string;
	nextCursor: string | null;
}>;

function page(spec: PageSpec): Response {
	return new Response(JSON.stringify({
		ops: [{
			op: {
				type: "custom_json_operation",
				value: {
					id: "nftlox_testnet",
					json: "{}",
					required_auths: [],
					required_posting_auths: [],
				},
			},
			block: spec.block,
			trx_id: `tx-${spec.operationId}`,
			timestamp: "2024-01-01T00:00:00",
			operation_id: spec.operationId,
			virtual_op: false,
		}],
		next_operation_begin: spec.nextCursor,
	}), { status: 200, headers: { "Content-Type": "application/json" } });
}

function emptyPage(nextCursor: string | null): Response {
	return new Response(JSON.stringify({
		ops: [],
		next_operation_begin: nextCursor,
	}), { status: 200, headers: { "Content-Type": "application/json" } });
}

function installFetch(
	handler: (url: URL) => Response | Promise<Response>,
): string[] {
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		calls.push(url.toString());
		return handler(url);
	}) as typeof fetch;
	return calls;
}

function cursorsFor(calls: readonly string[], endpoint: string): string[] {
	return calls
		.filter((call) => call.startsWith(`${endpoint}/`))
		.map((call) => new URL(call).searchParams.get("operation-begin") ?? "");
}

describe("HAFAH range consistency", () => {
	test("keeps every page of a successful range on the selected provider", async () => {
		const calls = installFetch((url) => {
			const cursor = url.searchParams.get("operation-begin");
			if (cursor === "-1") return page({ block: 100, operationId: "1", nextCursor: "100" });
			if (cursor === "100") return page({ block: 101, operationId: "2", nextCursor: "200" });
			if (cursor === "200") return page({ block: 102, operationId: "3", nextCursor: "0" });
			throw new Error(`unexpected cursor ${cursor}`);
		});

		const result = await fetchRangeFromEndpoint(EP_A, 100, 200, "nftlox_testnet", 100);

		expect(result).toHaveLength(3);
		expect(cursorsFor(calls, EP_A)).toEqual(["-1", "100", "200"]);
		expect(cursorsFor(calls, EP_B)).toEqual([]);
	});

	test("restarts the whole range on B after A fails mid-range", async () => {
		const calls = installFetch((url) => {
			const cursor = url.searchParams.get("operation-begin");
			if (url.origin === EP_A) {
				if (cursor === "-1") return page({ block: 100, operationId: "1", nextCursor: "111" });
				if (cursor === "111") return page({ block: 101, operationId: "2", nextCursor: "222" });
				return new Response("temporary failure", { status: 503 });
			}
			if (cursor === "-1") return page({ block: 100, operationId: "10", nextCursor: "333" });
			if (cursor === "333") return page({ block: 101, operationId: "11", nextCursor: "444" });
			if (cursor === "444") return page({ block: 102, operationId: "12", nextCursor: "0" });
			throw new Error(`unexpected B cursor ${cursor}`);
		});

		const result = await fetchRangeWithFailover(100, 200, "nftlox_testnet", 100);

		expect(result.map((operation) => operation.operation_id)).toEqual(["10", "11", "12"]);
		expect(cursorsFor(calls, EP_A)).toEqual(["-1", "111", "222"]);
		expect(cursorsFor(calls, EP_B)).toEqual(["-1", "333", "444"]);
	});

	test("rejects a non-advancing cursor and restarts on another provider", async () => {
		const calls = installFetch((url) => {
			const cursor = url.searchParams.get("operation-begin");
			if (url.origin === EP_A) {
				if (cursor === "-1") return page({ block: 100, operationId: "1", nextCursor: "100" });
				return page({ block: 101, operationId: "2", nextCursor: "100" });
			}
			return emptyPage("0");
		});

		await expect(fetchRangeWithFailover(100, 200, "nftlox_testnet", 100)).resolves.toEqual([]);
		expect(cursorsFor(calls, EP_A)).toEqual(["-1", "100"]);
		expect(cursorsFor(calls, EP_B)).toEqual(["-1"]);
	});

	test("rejects a cursor cycle and discards the partial range", async () => {
		const calls = installFetch((url) => {
			const cursor = url.searchParams.get("operation-begin");
			if (url.origin === EP_A) {
				if (cursor === "-1") return page({ block: 100, operationId: "1", nextCursor: "100" });
				if (cursor === "100") return page({ block: 101, operationId: "2", nextCursor: "200" });
				return page({ block: 102, operationId: "3", nextCursor: "100" });
			}
			return emptyPage("0");
		});

		await expect(fetchRangeWithFailover(100, 200, "nftlox_testnet", 100)).resolves.toEqual([]);
		expect(cursorsFor(calls, EP_A)).toEqual(["-1", "100", "200"]);
		expect(cursorsFor(calls, EP_B)).toEqual(["-1"]);
	});

	test("rejects an operation outside the requested block range", async () => {
		const calls = installFetch((url) => {
			if (url.origin === EP_A) {
				return page({ block: 2001, operationId: "1", nextCursor: "0" });
			}
			return emptyPage("0");
		});

		await expect(fetchRangeWithFailover(1000, 2000, "nftlox_testnet", 100)).resolves.toEqual([]);
		expect(cursorsFor(calls, EP_A)).toEqual(["-1"]);
		expect(cursorsFor(calls, EP_B)).toEqual(["-1"]);
	});

	test("does not return a partial result when a provider exceeds the page limit", async () => {
		const calls = installFetch(() => {
			const cursor = new URL(calls.at(-1)!).searchParams.get("operation-begin");
			const nextCursor = cursor === "-1" ? "1" : String(Number(cursor) + 1);
			return page({ block: 100, operationId: nextCursor, nextCursor });
		});

		await expect(fetchRangeFromEndpoint(EP_A, 100, 200, "nftlox_testnet", 100))
			.rejects
			.toThrow("pagination overflow");
		expect(calls).toHaveLength(100);
	});

	test("accepts a terminal cursor on the maximum allowed page", async () => {
		let pageNumber = 0;
		installFetch(() => {
			pageNumber++;
			const nextCursor = pageNumber === 100 ? "0" : String(pageNumber);
			return page({ block: 100, operationId: String(pageNumber), nextCursor });
		});

		const result = await fetchRangeFromEndpoint(EP_A, 100, 200, "nftlox_testnet", 100);

		expect(result).toHaveLength(100);
	});

	test("isolates provider cursors when A fails after producing its own sequence", async () => {
		const calls = installFetch((url) => {
			const cursor = url.searchParams.get("operation-begin");
			if (url.origin === EP_A) {
				if (cursor === "-1") return page({ block: 100, operationId: "20", nextCursor: "100" });
				if (cursor === "100") return page({ block: 101, operationId: "21", nextCursor: "200" });
				return new Response("provider A failed", { status: 500 });
			}
			if (cursor === "-1") return emptyPage("0");
			throw new Error(`provider B received A cursor ${cursor}`);
		});

		await expect(fetchRangeWithFailover(100, 200, "nftlox_testnet", 100)).resolves.toEqual([]);
		expect(cursorsFor(calls, EP_B)).toEqual(["-1"]);
	});

	test("rejects malformed cursors at the page boundary", async () => {
		installFetch(() => emptyPage("not-a-cursor"));

		await expect(fetchRangeFromEndpoint(EP_A, 100, 200, "nftlox_testnet", 100))
			.rejects
			.toThrow("invalid cursor");
	});

	test("rejects duplicate operation IDs across pages", async () => {
		installFetch((url) => {
			const cursor = url.searchParams.get("operation-begin");
			if (cursor === "-1") return page({ block: 100, operationId: "1", nextCursor: "100" });
			return page({ block: 101, operationId: "1", nextCursor: "0" });
		});

		await expect(fetchRangeFromEndpoint(EP_A, 100, 200, "nftlox_testnet", 100))
			.rejects
			.toThrow("duplicate operation_id");
	});
});
