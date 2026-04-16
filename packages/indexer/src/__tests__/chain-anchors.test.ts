import { describe, expect, test, mock, beforeEach } from "bun:test";
import { PROTOCOL_GENESIS_BLOCK, PROTOCOL_GENESIS_BLOCK_ID } from "@/protocol/index.ts";

const mockGetBlockIdFromAllEndpoints = mock(
	(_blockNum: number): Promise<ReadonlyArray<{ endpoint: string; blockId: string }>> =>
		Promise.resolve([]),
);

mock.module("@/scanner/hive-client.ts", () => ({
	getBlockIdFromAllEndpoints: mockGetBlockIdFromAllEndpoints,
	// Stubs below keep the module's export shape complete so bun's process-wide
	// mock registry doesn't starve sibling test files (e.g. status-route.test.ts)
	// that import other symbols from hive-client.
	getBlockchainHead: () => Promise.resolve({ headBlock: 0, irreversibleBlock: 0 }),
	checkClockDrift: () => Promise.resolve({ ok: true, driftMs: 0 }),
	getHeadBlockNum: () => Promise.resolve(0),
	getCustomJsonInRange: () => Promise.resolve([]),
	getHafAHBlockRange: () => 0,
	getTransfersInTransaction: () => Promise.resolve([]),
	selectConsensusHead: () => ({ headBlock: 0, irreversibleBlock: 0 }),
}));

const { verifyChainAnchors, ChainAnchorMismatchError } = await import(
	"@/scanner/chain-anchors.ts"
);

function agreeingSamples(blockId: string, n = 2) {
	return Array.from({ length: n }, (_, i) => ({
		endpoint: `https://endpoint-${i}.test`,
		blockId,
	}));
}

describe("verifyChainAnchors", () => {
	beforeEach(() => {
		mockGetBlockIdFromAllEndpoints.mockReset();
	});

	test("passes when genesis matches on a quorum of endpoints", async () => {
		mockGetBlockIdFromAllEndpoints.mockResolvedValue(
			agreeingSamples(PROTOCOL_GENESIS_BLOCK_ID),
		);
		await expect(verifyChainAnchors()).resolves.toBeUndefined();
	});

	test("aborts when the live chain returns a different genesis block_id", async () => {
		mockGetBlockIdFromAllEndpoints.mockResolvedValue(
			agreeingSamples("0000000000000000000000000000000000000000"),
		);
		await expect(verifyChainAnchors()).rejects.toBeInstanceOf(ChainAnchorMismatchError);
	});

	test("aborts when fewer than two endpoints answer the genesis probe", async () => {
		mockGetBlockIdFromAllEndpoints.mockResolvedValue([
			{ endpoint: "single", blockId: PROTOCOL_GENESIS_BLOCK_ID },
		]);
		await expect(verifyChainAnchors()).rejects.toThrow(/only 1\/2 endpoints responded/);
	});

	test("probes exactly the genesis block (no per-restart rolling window)", async () => {
		mockGetBlockIdFromAllEndpoints.mockResolvedValue(
			agreeingSamples(PROTOCOL_GENESIS_BLOCK_ID),
		);
		await verifyChainAnchors();
		expect(mockGetBlockIdFromAllEndpoints).toHaveBeenCalledTimes(1);
		expect(mockGetBlockIdFromAllEndpoints).toHaveBeenCalledWith(PROTOCOL_GENESIS_BLOCK);
	});
});
