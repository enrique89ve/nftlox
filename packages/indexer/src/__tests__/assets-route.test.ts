import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type AssetRow = Readonly<{ id: string; owner: string; collection_id: string }>;

// Shared state between the test body and the mock so each test can dictate the
// resolved rows without rewiring mock.module in every case.
let mockAssetsById: Map<string, AssetRow> = new Map();

mock.module("@/db/queries/assets.ts", () => ({
	getAssetById: (id: string) => Promise.resolve(mockAssetsById.get(id) ?? null),
	getAssetsByIds: (ids: readonly string[]) => {
		const rows: AssetRow[] = [];
		for (const id of ids) {
			const row = mockAssetsById.get(id);
			if (row) rows.push(row);
		}
		return Promise.resolve(rows);
	},
	getAssetOwnerClaim: () => Promise.resolve(null),
	getAssetOwnershipProof: () => Promise.resolve(null),
	getSeedSummary: () => Promise.resolve(null),
	queryAssets: () => Promise.resolve([]),
	queryRawInstances: () => Promise.resolve([]),
}));

mock.module("@/db/queries/loans.ts", () => ({
	getAssetLoan: () => Promise.resolve(null),
}));

const { Elysia } = await import("elysia");
const { assetsRoutes } = await import("@/api/routes/assets.ts");

function buildApp() {
	return new Elysia().use(assetsRoutes);
}

function row(id: string): AssetRow {
	return { id, owner: "alice", collection_id: "col_1" };
}

describe("GET /api/assets?ids=...", () => {
	beforeEach(() => {
		mockAssetsById = new Map();
	});
	afterEach(() => {
		mockAssetsById = new Map();
	});

	test("returns items and empty missing array for happy-path batch", async () => {
		mockAssetsById.set("asset_1", row("asset_1"));
		mockAssetsById.set("asset_2", row("asset_2"));
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/assets?ids=asset_1,asset_2"),
		);
		const json = (await response.json()) as { items: AssetRow[]; missing: string[] };

		expect(response.status).toBe(200);
		expect(json.items.map(i => i.id).sort()).toEqual(["asset_1", "asset_2"]);
		expect(json.missing).toEqual([]);
	});

	test("reports not-yet-indexed ids in missing[] rather than 404", async () => {
		mockAssetsById.set("asset_1", row("asset_1"));
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/assets?ids=asset_1,asset_ghost"),
		);
		const json = (await response.json()) as { items: AssetRow[]; missing: string[] };

		expect(response.status).toBe(200);
		expect(json.items).toHaveLength(1);
		expect(json.items[0]!.id).toBe("asset_1");
		expect(json.missing).toEqual(["asset_ghost"]);
	});

	test("dedupes duplicate ids before querying", async () => {
		mockAssetsById.set("asset_1", row("asset_1"));
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/assets?ids=asset_1,asset_1,asset_1"),
		);
		const json = (await response.json()) as { items: AssetRow[]; missing: string[] };

		expect(response.status).toBe(200);
		expect(json.items).toHaveLength(1);
		expect(json.missing).toEqual([]);
	});

	test("returns 400 when the batch exceeds the 200-id cap", async () => {
		const ids = Array.from({ length: 201 }, (_, i) => `asset_${i}`).join(",");
		const app = buildApp();

		const response = await app.handle(
			new Request(`http://localhost/api/assets?ids=${ids}`),
		);
		const json = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(json.error).toMatch(/max 200/);
	});

	test("returns 400 when an id violates the length bounds", async () => {
		const app = buildApp();
		const overlong = "a".repeat(129);

		const response = await app.handle(
			new Request(`http://localhost/api/assets?ids=${overlong}`),
		);
		const json = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(json.error).toMatch(/length must be/);
	});

	test("returns 400 when ids param is empty / only commas", async () => {
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/assets?ids=,,,"),
		);
		const json = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(json.error).toMatch(/at least one id/);
	});

	test("the batch handler does not swallow the singleton /:id path", async () => {
		mockAssetsById.set("asset_single", row("asset_single"));
		const app = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/assets/asset_single"),
		);
		const json = (await response.json()) as AssetRow;

		expect(response.status).toBe(200);
		expect(json.id).toBe("asset_single");
	});
});
