import { describe, expect, mock, test } from "bun:test";

// GET /api/state-root contract
// ----------------------------
// Public commitment to the projected NFT state. Two indexers processing the
// same HafAH stream must converge on the same root, so the endpoint is how
// an external observer compares projections across nodes in O(1).

const fixedUpdatedAt = "2026-04-15T10:00:00.000Z";
const fixedRootHex = "ab".repeat(32);
const fixedRoot = `sha256:${fixedRootHex}`;

let mockMeta = {
	state_root: fixedRoot,
	nft_count: 42,
	last_block_num: 105_530_600,
	updated_at: fixedUpdatedAt,
};

// Bun's `mock.module` is process-wide, so the stub must keep every export
// that other test files may touch via `nft-mutations.ts` → `state-root.ts`.
mock.module("@/db/queries/state-root.ts", () => ({
	getFormattedStateRoot: () => Promise.resolve(mockMeta),
	getStateMeta: () => Promise.resolve({
		state_root: new Uint8Array(32),
		nft_count: 0,
		last_block_num: 0,
		updated_at: fixedUpdatedAt,
	}),
	bootstrapStateRootFromFullScan: () => Promise.resolve({
		state_root: new Uint8Array(32),
		nft_count: 0,
		last_block_num: 0,
		updated_at: fixedUpdatedAt,
	}),
	computeStateRootFullScan: () => Promise.resolve(new Uint8Array(32)),
}));

const { Elysia } = await import("elysia");
const { stateRootRoutes } = await import("@/api/routes/state-root.ts");

function buildApp() {
	return new Elysia().use(stateRootRoutes);
}

describe("GET /api/state-root", () => {
	test("returns the singleton commitment with SPV-friendly shape", async () => {
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/api/state-root"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.state_root).toBe(fixedRoot);
		expect(body.nft_count).toBe(42);
		expect(body.last_block_num).toBe(105_530_600);
		expect(body.updated_at).toBe(fixedUpdatedAt);
	});

	test("state_root is always prefixed sha256: plus 64 lowercase hex chars", async () => {
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/api/state-root"));
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.state_root).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("reflects updates to the underlying meta between calls", async () => {
		mockMeta = {
			state_root: `sha256:${"cd".repeat(32)}`,
			nft_count: 100,
			last_block_num: 105_530_999,
			updated_at: "2026-04-15T10:05:00.000Z",
		};
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/api/state-root"));
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.state_root).toBe(`sha256:${"cd".repeat(32)}`);
		expect(body.nft_count).toBe(100);
		expect(body.last_block_num).toBe(105_530_999);
	});
});
