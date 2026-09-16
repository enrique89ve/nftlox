import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type NftRow = Readonly<{ id: string; owner: string; collection_id: string }>;

// Shared state between the test body and the mock so each test can dictate the
// resolved rows without rewiring mock.module in every case.
let mockNftsById: Map<string, NftRow> = new Map();

mock.module("@/db/queries/nfts.ts", () => ({
	getNftById: (id: string) => Promise.resolve(mockNftsById.get(id) ?? null),
	getNftsByIds: (ids: readonly string[]) => {
		const rows: NftRow[] = [];
		for (const id of ids) {
			const row = mockNftsById.get(id);
			if (row) rows.push(row);
		}
		return Promise.resolve(rows);
	},
	getNftOwnerClaim: () => Promise.resolve(null),
	getNftOwnershipProof: () => Promise.resolve(null),
	getSeedSummary: () => Promise.resolve(null),
	queryNfts: () => Promise.resolve([]),
	queryRawInstances: () => Promise.resolve([]),
}));

mock.module("@/db/queries/loans.ts", () => ({
	getNftLoan: () => Promise.resolve(null),
}));

const { Elysia } = await import("elysia");
const { nftsRoutes } = await import("@/api/routes/nfts.ts");

function buildApp() {
	return new Elysia().use(nftsRoutes);
}

function row(id: string): NftRow {
	return { id, owner: "alice", collection_id: "col_1" };
}

describe("GET /api/nfts?ids=...", () => {
	beforeEach(() => {
		mockNftsById = new Map();
	});
	afterEach(() => {
		mockNftsById = new Map();
	});

	test("returns items and empty missing array for happy-path batch", async () => {
		mockNftsById.set("nft_1", row("nft_1"));
		mockNftsById.set("nft_2", row("nft_2"));
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/nfts?ids=nft_1,nft_2"),
		);
		const json = (await response.json()) as { items: NftRow[]; missing: string[] };

		expect(response.status).toBe(200);
		expect(json.items.map(i => i.id).sort()).toEqual(["nft_1", "nft_2"]);
		expect(json.missing).toEqual([]);
	});

	test("reports not-yet-indexed ids in missing[] rather than 404", async () => {
		mockNftsById.set("nft_1", row("nft_1"));
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/nfts?ids=nft_1,nft_ghost"),
		);
		const json = (await response.json()) as { items: NftRow[]; missing: string[] };

		expect(response.status).toBe(200);
		expect(json.items).toHaveLength(1);
		expect(json.items[0]!.id).toBe("nft_1");
		expect(json.missing).toEqual(["nft_ghost"]);
	});

	test("dedupes duplicate ids before querying", async () => {
		mockNftsById.set("nft_1", row("nft_1"));
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/nfts?ids=nft_1,nft_1,nft_1"),
		);
		const json = (await response.json()) as { items: NftRow[]; missing: string[] };

		expect(response.status).toBe(200);
		expect(json.items).toHaveLength(1);
		expect(json.missing).toEqual([]);
	});

	test("returns 400 when the batch exceeds the 200-id cap", async () => {
		const ids = Array.from({ length: 201 }, (_, i) => `nft_${i}`).join(",");
		const app = buildApp();

		const response = await app.handle(
			new Request(`http://localhost/api/nfts?ids=${ids}`),
		);
		const json = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(json.error).toMatch(/max 200/);
	});

	test("returns 400 when an id violates the length bounds", async () => {
		const app = buildApp();
		const overlong = "a".repeat(129);

		const response = await app.handle(
			new Request(`http://localhost/api/nfts?ids=${overlong}`),
		);
		const json = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(json.error).toMatch(/length must be/);
	});

	test("returns 400 when ids param is empty / only commas", async () => {
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/nfts?ids=,,,"),
		);
		const json = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(json.error).toMatch(/at least one id/);
	});

	test("the batch handler does not swallow the singleton /:id path", async () => {
		mockNftsById.set("nft_single", row("nft_single"));
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/nfts/nft_single"),
		);
		const json = (await response.json()) as NftRow;

		expect(response.status).toBe(200);
		expect(json.id).toBe("nft_single");
	});
});
