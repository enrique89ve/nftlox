import { beforeEach, describe, expect, mock, test } from "bun:test";

// SPV provenance contract
// -----------------------
// The indexer's public Asset reads must expose enough ownership metadata for a
// client to verify the current owner against HafAH without trusting us.
//
// The minimum set is:
//   - owner              : current owner account
//   - previous_owner     : account that held the Asset before the latest change
//   - owner_action       : which protocol action last changed ownership
//   - owner_operation_id : HafAH operation id of that action
//   - owner_block_num    : block in which the action landed
//   - collection_id + collection_created_{block_num,tx_id}: collection anchor
//     used by SPV buy verification to resolve create_collection rules on L1
//
// With those five fields the client can pick any HafAH lookup path
// (`/operations/{id}`, `/accounts/:acc/operations`, `get_ops_in_block`, ...)
// and re-derive the tx_id, signatures, and custom_json body independently.
// This test fails if any Asset-returning endpoint drops one of those fields.

type ProvenanceFixture = Readonly<{
	owner: string;
	previous_owner: string | null;
	owner_action: string;
	owner_operation_id: string;
	owner_block_num: number;
}>;

const PROVENANCE: ProvenanceFixture = Object.freeze({
	owner: "alice",
	previous_owner: "bob",
	owner_action: "transfer",
	owner_operation_id: "3448858738752",
	owner_block_num: 105_530_600,
});

function makeAssetRow(id: string): Record<string, unknown> {
	return {
		id,
		collection_id: "col_1",
		asset_type: "instance",
		status: "active",
		...PROVENANCE,
	};
}

function makeOwnerClaim(id: string): Record<string, unknown> {
	return {
		id,
		...PROVENANCE,
		claim_hash: `0x${"a".repeat(64)}`,
	};
}

function makeOwnershipProof(id: string): Record<string, unknown> {
	return {
		...makeOwnerClaim(id),
		created_operation_id: "3448858700000",
		created_block_num: 105_530_500,
		created_tx_id: "abc123",
		asset_type: "instance",
		seed_id: "seed_1",
		instance_number: 1,
		asset_dna: "0x" + "b".repeat(40),
		collection_id: "col_1",
		collection_created_block_num: 105_530_400,
		collection_created_tx_id: "0".repeat(40),
	};
}

mock.module("@/db/queries/assets.ts", () => ({
	getAssetById: (id: string) => Promise.resolve(makeAssetRow(id)),
	getAssetsByIds: (ids: readonly string[]) =>
		Promise.resolve(ids.map((id) => makeAssetRow(id))),
	getAssetOwnerClaim: (id: string) => Promise.resolve(makeOwnerClaim(id)),
	getAssetOwnershipProof: (id: string) => Promise.resolve(makeOwnershipProof(id)),
	getSeedSummary: (id: string) => Promise.resolve(makeAssetRow(id)),
	queryAssets: (query: { seedId?: string }) =>
		Promise.resolve([makeAssetRow(query.seedId ?? "asset_1")]),
	queryRawInstances: () => Promise.resolve([makeAssetRow("inst_1")]),
}));

mock.module("@/db/queries/loans.ts", () => ({
	getAssetLoan: () => Promise.resolve(null),
}));

const { Elysia } = await import("elysia");
const { assetsRoutes } = await import("@/api/routes/assets.ts");

function buildApp() {
	return new Elysia().use(assetsRoutes);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProvenance(value: unknown): boolean {
	if (!isObject(value)) return false;
	return (
		typeof value.owner === "string"
		&& (value.previous_owner === null || typeof value.previous_owner === "string")
		&& typeof value.owner_action === "string"
		&& typeof value.owner_operation_id === "string"
		&& typeof value.owner_block_num === "number"
	);
}

function hasCollectionAnchor(value: unknown): boolean {
	if (!isObject(value)) return false;
	return (
		typeof value.collection_id === "string"
		&& typeof value.collection_created_block_num === "number"
		&& typeof value.collection_created_tx_id === "string"
	);
}

type EndpointCase = Readonly<{
	name: string;
	path: string;
	extract: (body: unknown) => readonly unknown[];
}>;

function extractBatch(body: unknown): readonly unknown[] {
	if (!isObject(body) || !Array.isArray(body.items)) return [];
	return body.items;
}

function extractCompactInstances(body: unknown): readonly unknown[] {
	if (!isObject(body)) return [];
	const { seed, instances } = body;
	if (!isObject(seed) || !Array.isArray(instances)) return [];
	return [seed, ...instances];
}

const CASES: readonly EndpointCase[] = [
	{
		name: "GET /api/assets?ids=...",
		path: "/api/assets?ids=asset_1,asset_2",
		extract: extractBatch,
	},
	{
		name: "GET /api/assets/:id",
		path: "/api/assets/asset_1",
		extract: (body) => [body],
	},
	{
		name: "GET /api/assets/:id/owner",
		path: "/api/assets/asset_1/owner",
		extract: (body) => [body],
	},
	{
		name: "GET /api/assets/:id/ownership",
		path: "/api/assets/asset_1/ownership",
		extract: (body) => [body],
	},
	{
		name: "GET /api/assets/:id/proof",
		path: "/api/assets/asset_1/proof",
		extract: (body) => [body],
	},
	{
		name: "GET /api/assets/:id/instances (non-compact)",
		path: "/api/assets/seed_1/instances",
		extract: (body) => (Array.isArray(body) ? body : []),
	},
	{
		name: "GET /api/assets/:id/instances?compact=true",
		path: "/api/assets/seed_1/instances?compact=true",
		extract: extractCompactInstances,
	},
];

describe("SPV provenance contract across Asset reads", () => {
	let app: ReturnType<typeof buildApp>;

	beforeEach(() => {
		app = buildApp();
	});

	for (const testCase of CASES) {
		test(`${testCase.name} exposes all SPV provenance fields`, async () => {
			const response = await app.handle(
				new Request(`http://localhost${testCase.path}`),
			);
			expect(response.status).toBe(200);

			const body = (await response.json()) as unknown;
			const rows = testCase.extract(body);

			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				if (!hasProvenance(row)) {
					throw new Error(
						`${testCase.name}: row is missing one or more SPV fields. Got: ${JSON.stringify(row)}`,
					);
				}
				expect(hasProvenance(row)).toBe(true);
			}
		});
	}

	test("hasProvenance rejects rows that drop any of the five required fields", () => {
		const complete = { ...PROVENANCE };
		expect(hasProvenance(complete)).toBe(true);

		for (const field of Object.keys(PROVENANCE)) {
			const { [field]: _removed, ...rest } = complete as Record<string, unknown>;
			expect(hasProvenance(rest)).toBe(false);
		}
	});

	test("ownership proof exposes the collection L1 anchor used by SPV buy checks", async () => {
		const response = await app.handle(new Request("http://localhost/api/assets/asset_1/proof"));
		expect(response.status).toBe(200);
		const body = (await response.json()) as unknown;
		expect(hasCollectionAnchor(body)).toBe(true);
	});
});
