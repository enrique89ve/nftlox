import { beforeEach, describe, expect, mock, test } from "bun:test";

// SPV provenance contract
// -----------------------
// The indexer's public NFT reads must expose enough ownership metadata for a
// client to verify the current owner against HafAH without trusting us.
//
// The minimum set is:
//   - owner              : current owner account
//   - previous_owner     : account that held the NFT before the latest change
//   - owner_action       : which protocol action last changed ownership
//   - owner_operation_id : HafAH operation id of that action
//   - owner_block_num    : block in which the action landed
//
// With those five fields the client can pick any HafAH lookup path
// (`/operations/{id}`, `/accounts/:acc/operations`, `get_ops_in_block`, ...)
// and re-derive the tx_id, signatures, and custom_json body independently.
// This test fails if any NFT-returning endpoint drops one of those fields.

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

function makeNftRow(id: string): Record<string, unknown> {
	return {
		id,
		collection_id: "col_1",
		nft_type: "instance",
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
		nft_type: "instance",
		seed_id: "seed_1",
		instance_number: 1,
		nft_dna: "0x" + "b".repeat(40),
	};
}

mock.module("@/db/queries/nfts.ts", () => ({
	getNftById: (id: string) => Promise.resolve(makeNftRow(id)),
	getNftsByIds: (ids: readonly string[]) =>
		Promise.resolve(ids.map((id) => makeNftRow(id))),
	getNftOwnerClaim: (id: string) => Promise.resolve(makeOwnerClaim(id)),
	getNftOwnershipProof: (id: string) => Promise.resolve(makeOwnershipProof(id)),
	getSeedSummary: (id: string) => Promise.resolve(makeNftRow(id)),
	queryNfts: (query: { seedId?: string }) =>
		Promise.resolve([makeNftRow(query.seedId ?? "nft_1")]),
	queryRawInstances: () => Promise.resolve([makeNftRow("inst_1")]),
}));

mock.module("@/db/queries/loans.ts", () => ({
	getNftLoan: () => Promise.resolve(null),
}));

const { Elysia } = await import("elysia");
const { nftsRoutes } = await import("@/api/routes/nfts.ts");

function buildApp() {
	return new Elysia().use(nftsRoutes);
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
		name: "GET /api/nfts?ids=...",
		path: "/api/nfts?ids=nft_1,nft_2",
		extract: extractBatch,
	},
	{
		name: "GET /api/nfts/:id",
		path: "/api/nfts/nft_1",
		extract: (body) => [body],
	},
	{
		name: "GET /api/nfts/:id/owner",
		path: "/api/nfts/nft_1/owner",
		extract: (body) => [body],
	},
	{
		name: "GET /api/nfts/:id/ownership",
		path: "/api/nfts/nft_1/ownership",
		extract: (body) => [body],
	},
	{
		name: "GET /api/nfts/:id/proof",
		path: "/api/nfts/nft_1/proof",
		extract: (body) => [body],
	},
	{
		name: "GET /api/nfts/:id/instances (non-compact)",
		path: "/api/nfts/seed_1/instances",
		extract: (body) => (Array.isArray(body) ? body : []),
	},
	{
		name: "GET /api/nfts/:id/instances?compact=true",
		path: "/api/nfts/seed_1/instances?compact=true",
		extract: extractCompactInstances,
	},
];

describe("SPV provenance contract across NFT reads", () => {
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
});
