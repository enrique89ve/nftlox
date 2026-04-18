import { describe, expect, test } from "bun:test";
import {
	MAX_PACK_OPEN_BATCH,
	buildPackOpenPlan,
	buildPackOpenSeed,
	computeReservedSupply,
	createPackDefinition,
	selectPackSeedIds,
	validateReservationDemand,
} from "../src/index.ts";

describe("packs-engine", () => {
	test("computes reserved supply per seed for finite packs", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Starter Pack",
			dropTable: [
				{ seedId: "seed_a", weight: 70 },
				{ seedId: "seed_b", weight: 30 },
			],
			itemsPerPack: 2,
			maxSupply: 10,
		});

		expect(computeReservedSupply(definition)).toEqual({
			seed_a: 14,
			seed_b: 6,
		});
	});

	test("builds a deterministic bulk_distribute plan", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Starter Pack",
			dropTable: [
				{ seedId: "seed_a", weight: 70 },
				{ seedId: "seed_b", weight: 30 },
			],
			itemsPerPack: 2,
			maxSupply: 10,
		});

		const plan = buildPackOpenPlan({
			definition,
			seedSnapshots: [
				{ seedId: "seed_a", seedTxId: "a".repeat(40), maxSupply: 100, distributed: 10, reserved: 20 },
				{ seedId: "seed_b", seedTxId: "b".repeat(40), maxSupply: 100, distributed: 5, reserved: 10 },
			],
			context: {
				txId: "c".repeat(40),
				operationId: "op_1",
				blockNum: 123,
				owner: "alice",
				quantity: 2,
			},
			reservationAvailabilityBySeed: {
				seed_a: 10,
				seed_b: 10,
			},
		});

		expect(plan.deliveredPacks).toBe(2);
		expect(plan.skippedPacks).toBe(0);
		expect(plan.items.reduce((sum, item) => sum + item.quantity, 0)).toBe(4);
		expect(plan.reservationConsumption.reduce((sum, item) => sum + item.quantity, 0)).toBe(4);
	});

	test("rejects pack definitions whose reservation demand exceeds seed supply", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Tight Pack",
			dropTable: [
				{ seedId: "seed_a", weight: 100 },
			],
			itemsPerPack: 1,
			maxSupply: 5,
		});

		expect(() => validateReservationDemand(definition, [
			{ seedId: "seed_a", seedTxId: "a".repeat(40), maxSupply: 4, distributed: 0, reserved: 0 },
		])).toThrow("Seed seed_a needs 5 reserved supply but only 4 is available");
	});

	test("skips packs when a drop-table seed is missing from snapshots", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Missing Seed Pack",
			dropTable: [{ seedId: "seed_absent", weight: 1 }],
			itemsPerPack: 1,
			maxSupply: 10,
		});

		const plan = buildPackOpenPlan({
			definition,
			seedSnapshots: [],
			context: { txId: "c".repeat(40), operationId: "op_missing", blockNum: 1, owner: "alice", quantity: 3 },
		});

		expect(plan.deliveredPacks).toBe(0);
		expect(plan.skippedPacks).toBe(3);
		expect(plan.items).toHaveLength(0);
		expect(plan.selections.every(sel => sel.reason === "missing_seed")).toBe(true);
	});

	test("skips packs when finite supply runs out mid-batch", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Tiny Supply",
			dropTable: [{ seedId: "seed_a", weight: 1 }],
			itemsPerPack: 1,
			maxSupply: 10,
		});

		const plan = buildPackOpenPlan({
			definition,
			seedSnapshots: [
				{ seedId: "seed_a", seedTxId: "a".repeat(40), maxSupply: 2, distributed: 0, reserved: 0 },
			],
			context: { txId: "c".repeat(40), operationId: "op_supply", blockNum: 1, owner: "alice", quantity: 5 },
		});

		expect(plan.deliveredPacks).toBe(2);
		expect(plan.skippedPacks).toBe(3);
		expect(plan.selections.filter(sel => sel.reason === "insufficient_supply")).toHaveLength(3);
	});

	test("skips packs when off-chain reservation is depleted", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Reservation Pack",
			dropTable: [{ seedId: "seed_a", weight: 1 }],
			itemsPerPack: 1,
			maxSupply: 10,
		});

		const plan = buildPackOpenPlan({
			definition,
			seedSnapshots: [
				{ seedId: "seed_a", seedTxId: "a".repeat(40), maxSupply: 100, distributed: 0, reserved: 0 },
			],
			context: { txId: "c".repeat(40), operationId: "op_reserve", blockNum: 1, owner: "alice", quantity: 3 },
			reservationAvailabilityBySeed: { seed_a: 1 },
		});

		expect(plan.deliveredPacks).toBe(1);
		expect(plan.skippedPacks).toBe(2);
		expect(plan.selections.filter(sel => sel.reason === "insufficient_reservation")).toHaveLength(2);
	});

	test("treats maxSupply=0 as unlimited and never exhausts supply", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Unlimited Pack",
			dropTable: [{ seedId: "seed_a", weight: 1 }],
			itemsPerPack: 1,
			maxSupply: 0,
		});

		expect(computeReservedSupply(definition)).toEqual({});

		const plan = buildPackOpenPlan({
			definition,
			seedSnapshots: [
				{ seedId: "seed_a", seedTxId: "a".repeat(40), maxSupply: 0, distributed: 999, reserved: 0 },
			],
			context: { txId: "c".repeat(40), operationId: "op_unlim", blockNum: 1, owner: "alice", quantity: 4 },
		});

		expect(plan.deliveredPacks).toBe(4);
		expect(plan.items[0]?.quantity).toBe(4);
	});

	test("aggregates quantities per seedId across multiple packs", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Aggregation Pack",
			dropTable: [{ seedId: "seed_a", weight: 1 }],
			itemsPerPack: 3,
			maxSupply: 100,
		});

		const plan = buildPackOpenPlan({
			definition,
			seedSnapshots: [
				{ seedId: "seed_a", seedTxId: "a".repeat(40), maxSupply: 1000, distributed: 0, reserved: 0 },
			],
			context: { txId: "c".repeat(40), operationId: "op_agg", blockNum: 1, owner: "alice", quantity: 5 },
		});

		expect(plan.items).toHaveLength(1);
		expect(plan.items[0]).toEqual({ seedId: "seed_a", seedTxId: "a".repeat(40), quantity: 15 });
	});

	test("rejects quantity exceeding MAX_PACK_OPEN_BATCH", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Batch Limit Pack",
			dropTable: [{ seedId: "seed_a", weight: 1 }],
			itemsPerPack: 1,
			maxSupply: 10000,
		});

		expect(() => buildPackOpenPlan({
			definition,
			seedSnapshots: [
				{ seedId: "seed_a", seedTxId: "a".repeat(40), maxSupply: 10000, distributed: 0, reserved: 0 },
			],
			context: {
				txId: "c".repeat(40),
				operationId: "op_batch",
				blockNum: 1,
				owner: "alice",
				quantity: MAX_PACK_OPEN_BATCH + 1,
			},
		})).toThrow(`quantity cannot exceed ${MAX_PACK_OPEN_BATCH}`);
	});

	test("selectPackSeedIds is deterministic for the same context and packIndex", async () => {
		const definition = await createPackDefinition({
			collectionId: "col_demo",
			name: "Determinism Pack",
			dropTable: [
				{ seedId: "seed_a", weight: 50 },
				{ seedId: "seed_b", weight: 50 },
			],
			itemsPerPack: 4,
			maxSupply: 10,
		});

		const context = { txId: "c".repeat(40), operationId: "op_det", blockNum: 100, owner: "alice" };
		const first = selectPackSeedIds(definition, context, 0);
		const second = selectPackSeedIds(definition, context, 0);
		const third = selectPackSeedIds(definition, context, 1);

		expect(first).toEqual(second);
		expect(first).not.toEqual(third);
	});

	test("buildPackOpenSeed produces the canonical colon-delimited format", () => {
		const seed = buildPackOpenSeed({
			txId: "abc",
			operationId: "op",
			blockNum: 42,
			owner: "alice",
			packDefinitionId: "pack_xyz",
			packIndex: 0,
		});
		expect(seed).toBe("abc:op:42:alice:pack_xyz:0");
	});
});
