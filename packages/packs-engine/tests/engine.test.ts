import { describe, expect, test } from "bun:test";
import { buildPackOpenPlan, computeReservedSupply, createPackDefinition, validateReservationDemand } from "../src/index.ts";

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
});
