import { afterEach, describe, expect, test } from "bun:test";
import { createHiveAccountClient } from "../scanner/account-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function accountResponse(names: readonly string[]): Response {
	return new Response(JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: names.map((name) => ({ name, created: "2020-03-06T12:22:51" })),
	}), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Hive account client", () => {
	test("returns canonical account creation timestamps", async () => {
		const client = createHiveAccountClient({
			endpoints: ["https://node-a.test"],
			fetchImpl: (async () => accountResponse(["gtg"])) as unknown as typeof fetch,
		});

		const result = await client.lookup(["gtg"]);

		expect(result.accounts.get("gtg")).toEqual({
			name: "gtg",
			createdAt: "2020-03-06T12:22:51.000Z",
		});
	});

	test("maps a mixed batch into existing and missing accounts", async () => {
		globalThis.fetch = (async () => accountResponse(["gtg", "blocktrades"])) as unknown as typeof fetch;
		const client = createHiveAccountClient({ endpoints: ["https://node-a.test"] });

		const result = await client.lookup([
			"gtg",
			"blocktrades",
			"zznftlox999999",
		]);

		expect([...result.accounts.keys()]).toEqual(["gtg", "blocktrades"]);
		expect([...result.missing]).toEqual(["zznftlox999999"]);
	});

	test("fails over from a transport error to the next endpoint", async () => {
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(String(input));
			if (calls.length === 1) throw new Error("node unavailable");
			return accountResponse(["alice"]);
		}) as unknown as typeof fetch;
		const client = createHiveAccountClient({
			endpoints: ["https://down.test", "https://healthy.test"],
		});

		const result = await client.lookup(["alice", "missing-account"]);

		expect(calls).toEqual(["https://down.test", "https://healthy.test"]);
		expect([...result.accounts.keys()]).toEqual(["alice"]);
		expect([...result.missing]).toEqual(["missing-account"]);
	});

	test("fails over after a non-success HTTP response", async () => {
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(String(input));
			if (calls.length === 1) return new Response("busy", { status: 503, statusText: "Service Unavailable" });
			return accountResponse(["alice"]);
		}) as unknown as typeof fetch;
		const client = createHiveAccountClient({
			endpoints: ["https://busy.test", "https://healthy.test"],
		});

		await expect(client.lookup(["alice"])).resolves.toMatchObject({
			requested: ["alice"],
		});
		expect(calls).toEqual(["https://busy.test", "https://healthy.test"]);
	});

	test("fails over when an endpoint omits the account creation timestamp", async () => {
		const calls: string[] = [];
		const client = createHiveAccountClient({
			endpoints: ["https://invalid.test", "https://healthy.test"],
			fetchImpl: (async (input: RequestInfo | URL) => {
				calls.push(String(input));
				if (calls.length === 1) {
					return new Response(JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: [{ name: "alice" }],
					}), { status: 200 });
				}
				return accountResponse(["alice"]);
			}) as unknown as typeof fetch,
		});

		const result = await client.lookup(["alice"]);

		expect(calls).toEqual(["https://invalid.test", "https://healthy.test"]);
		expect(result.accounts.has("alice")).toBe(true);
	});

	test("fails over after the first endpoint reaches its timeout", async () => {
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(String(input));
			if (calls.length === 1) {
				return await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("request timeout")), { once: true });
				});
			}
			return accountResponse(["alice"]);
		}) as unknown as typeof fetch;
		const client = createHiveAccountClient({
			endpoints: ["https://slow.test", "https://healthy.test"],
			timeoutMs: 20,
			deadlineMs: 100,
		});

		const result = await client.lookup(["alice"]);

		expect(calls).toEqual(["https://slow.test", "https://healthy.test"]);
		expect([...result.accounts.keys()]).toEqual(["alice"]);
	});

	test("does not turn total endpoint failure into missing accounts", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const client = createHiveAccountClient({
			endpoints: ["https://down-a.test", "https://down-b.test"],
		});

		await expect(client.lookup(["alice"])).rejects.toMatchObject({
			name: "HiveAccountLookupUnavailableError",
			code: "HIVE_ACCOUNT_LOOKUP_UNAVAILABLE",
			attemptedEndpoints: ["https://down-a.test", "https://down-b.test"],
		});
	});

	test("deduplicates requests and splits oversized batches", async () => {
		const requestSizes: number[] = [];
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { params: [string[]] };
			requestSizes.push(body.params[0].length);
			return accountResponse(body.params[0]);
		}) as unknown as typeof fetch;
		const client = createHiveAccountClient({
			endpoints: ["https://node.test"],
			batchSize: 2,
		});

		const result = await client.lookup(["alice", "alice", "bob", "charlie"]);

		expect(requestSizes).toEqual([2, 1]);
		expect([...result.requested]).toEqual(["alice", "bob", "charlie"]);
		expect([...result.missing]).toEqual([]);
	});

	test("sends up to 1000 accounts in one default batch", async () => {
		const requestSizes: number[] = [];
		const names = Array.from({ length: 1000 }, (_, index) => `account-${index}`);
		const client = createHiveAccountClient({
			endpoints: ["https://node.test"],
			fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as { params: [string[]] };
				requestSizes.push(body.params[0].length);
				return accountResponse(body.params[0]);
			}) as unknown as typeof fetch,
		});

		await client.lookup(names);

		expect(requestSizes).toEqual([1000]);
	});

	test("keeps a healthy fallback for every chunk after the primary fails", async () => {
		const calls: string[] = [];
		const client = createHiveAccountClient({
			endpoints: ["https://down.test", "https://healthy.test"],
			batchSize: 2,
			fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const endpoint = String(input);
				calls.push(endpoint);
				if (endpoint === "https://down.test") throw new Error("node unavailable");
				const body = JSON.parse(String(init?.body)) as { params: [string[]] };
				return accountResponse(body.params[0]);
			}) as unknown as typeof fetch,
		});

		const result = await client.lookup(["alice", "bob", "charlie"]);

		expect(calls).toEqual([
			"https://down.test",
			"https://healthy.test",
			"https://healthy.test",
		]);
		expect([...result.missing]).toEqual([]);
	});
});
