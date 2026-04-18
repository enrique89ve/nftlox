import {
	MAX_DROP_TABLE_ENTRIES,
	MAX_DROP_WEIGHT,
	MAX_ITEMS_PER_PACK,
	MIN_DROP_WEIGHT,
} from "./constants";
import { generateDeterministicPackId } from "./rng";
import type { PackDefinition, PackDefinitionInput, PackDropEntry, ReservationDemand, SeedSupplySnapshot } from "./types";

function assertFiniteInteger(value: number, field: string): void {
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new Error(`${field} must be a finite integer`);
	}
}

function assertValidDropEntry(entry: PackDropEntry, index: number): void {
	if (!entry.seedId) {
		throw new Error(`dropTable[${index}].seedId is required`);
	}
	if (!Number.isFinite(entry.weight) || entry.weight < MIN_DROP_WEIGHT || entry.weight > MAX_DROP_WEIGHT) {
		throw new Error(
			`dropTable[${index}].weight must be between ${MIN_DROP_WEIGHT} and ${MAX_DROP_WEIGHT}`,
		);
	}
}

export function assertValidPackDefinition(input: PackDefinitionInput): void {
	if (!input.collectionId) throw new Error("collectionId is required");
	if (!input.name) throw new Error("name is required");

	assertFiniteInteger(input.itemsPerPack, "itemsPerPack");
	if (input.itemsPerPack < 1 || input.itemsPerPack > MAX_ITEMS_PER_PACK) {
		throw new Error(`itemsPerPack must be between 1 and ${MAX_ITEMS_PER_PACK}`);
	}

	assertFiniteInteger(input.maxSupply, "maxSupply");
	if (input.maxSupply < 0) {
		throw new Error("maxSupply must be non-negative");
	}

	if (input.dropTable.length === 0) {
		throw new Error("dropTable cannot be empty");
	}
	if (input.dropTable.length > MAX_DROP_TABLE_ENTRIES) {
		throw new Error(`dropTable cannot exceed ${MAX_DROP_TABLE_ENTRIES} entries`);
	}

	const seenSeeds = new Set<string>();
	let totalWeight = 0;

	for (const [index, entry] of input.dropTable.entries()) {
		assertValidDropEntry(entry, index);
		if (seenSeeds.has(entry.seedId)) {
			throw new Error(`Duplicate seedId in dropTable: ${entry.seedId}`);
		}
		seenSeeds.add(entry.seedId);
		totalWeight += entry.weight;
	}

	if (totalWeight <= 0) {
		throw new Error("dropTable total weight must be greater than zero");
	}
}

export async function createPackDefinition(input: PackDefinitionInput): Promise<PackDefinition> {
	assertValidPackDefinition(input);

	return {
		...input,
		id: await generateDeterministicPackId(input.collectionId, input.name),
	};
}

export function computeReservedSupply(definition: PackDefinition): Readonly<Record<string, number>> {
	assertValidPackDefinition(definition);

	if (definition.maxSupply === 0) {
		return {};
	}

	const totalWeight = definition.dropTable.reduce((sum, entry) => sum + entry.weight, 0);
	const totalDemand = definition.maxSupply * definition.itemsPerPack;
	const reservedSupply: Record<string, number> = {};

	for (const entry of definition.dropTable) {
		reservedSupply[entry.seedId] = Math.ceil((totalDemand * entry.weight) / totalWeight);
	}

	return reservedSupply;
}

function getSnapshotBySeedId(
	seedSnapshots: ReadonlyArray<SeedSupplySnapshot>,
	seedId: string,
): SeedSupplySnapshot {
	const seed = seedSnapshots.find(item => item.seedId === seedId);
	if (!seed) throw new Error(`Seed snapshot not found: ${seedId}`);
	return seed;
}

export function validateReservationDemand(
	definition: PackDefinition,
	seedSnapshots: ReadonlyArray<SeedSupplySnapshot>,
): ReadonlyArray<ReservationDemand> {
	const reservedSupply = computeReservedSupply(definition);

	return Object.entries(reservedSupply).map(([seedId, reserved]) => {
		const snapshot = getSnapshotBySeedId(seedSnapshots, seedId);
		const unlimited = snapshot.maxSupply === 0;
		const finiteRemainingBefore = Math.max(0, snapshot.maxSupply - snapshot.distributed - snapshot.reserved);
		const remainingBefore = unlimited ? null : finiteRemainingBefore;
		const remainingAfter = unlimited ? null : finiteRemainingBefore - reserved;

		if (remainingAfter !== null && remainingAfter < 0) {
			throw new Error(
				`Seed ${seedId} needs ${reserved} reserved supply but only ${remainingBefore} is available`,
			);
		}

		return {
			seedId,
			reserved,
			remainingBefore,
			remainingAfter,
		};
	});
}
