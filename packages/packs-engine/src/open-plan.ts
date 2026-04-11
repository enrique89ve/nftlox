import type { BulkDistributeItem } from "nftlox-sdk";
import { MAX_PACK_OPEN_BATCH } from "./constants.ts";
import { resolveDropTable } from "./rng.ts";
import type {
	PackDefinition,
	PackOpenContext,
	PackOpenPlan,
	PackSelection,
	ReservationConsumption,
	SeedSupplySnapshot,
} from "./types.ts";
import { assertValidPackDefinition } from "./pack-definition.ts";

function getSeedSnapshotMap(seedSnapshots: ReadonlyArray<SeedSupplySnapshot>): ReadonlyMap<string, SeedSupplySnapshot> {
	return new Map(seedSnapshots.map(seed => [seed.seedId, seed]));
}

function getReservationMap(
	reservationAvailabilityBySeed: Readonly<Record<string, number>> | undefined,
): ReadonlyMap<string, number> | null {
	if (!reservationAvailabilityBySeed) return null;
	return new Map(Object.entries(reservationAvailabilityBySeed));
}

function createRngSeed(definitionId: string, context: PackOpenContext, packIndex: number): string {
	return `${context.txId}:${context.operationId}:${context.blockNum}:${context.owner}:${definitionId}:${packIndex}`;
}

export function selectPackSeedIds(
	definition: PackDefinition,
	context: Omit<PackOpenContext, "quantity">,
	packIndex: number,
): ReadonlyArray<string> {
	assertValidPackDefinition(definition);
	return resolveDropTable(
		[...definition.dropTable],
		definition.itemsPerPack,
		createRngSeed(definition.id, { ...context, quantity: 1 }, packIndex),
	);
}

export function buildPackOpenPlan(params: {
	readonly definition: PackDefinition;
	readonly seedSnapshots: ReadonlyArray<SeedSupplySnapshot>;
	readonly context: PackOpenContext;
	readonly reservationAvailabilityBySeed?: Readonly<Record<string, number>>;
}): PackOpenPlan {
	const { definition, seedSnapshots, context, reservationAvailabilityBySeed } = params;

	assertValidPackDefinition(definition);

	if (!Number.isFinite(context.quantity) || !Number.isInteger(context.quantity) || context.quantity < 1) {
		throw new Error("quantity must be a positive integer");
	}
	if (context.quantity > MAX_PACK_OPEN_BATCH) {
		throw new Error(`quantity cannot exceed ${MAX_PACK_OPEN_BATCH}`);
	}

	const seedsById = getSeedSnapshotMap(seedSnapshots);
	const reservationBySeed = getReservationMap(reservationAvailabilityBySeed);
	const plannedDistribution = new Map<string, number>();
	const plannedReservationConsumption = new Map<string, number>();
	const itemsBySeed = new Map<string, BulkDistributeItem>();
	const selections: PackSelection[] = [];

	for (let packIndex = 0; packIndex < context.quantity; packIndex++) {
		const selectedSeedIds = selectPackSeedIds(definition, context, packIndex);
		let delivered = true;
		let reason: PackSelection["reason"] = null;

		for (const seedId of selectedSeedIds) {
			const snapshot = seedsById.get(seedId);
			if (!snapshot) {
				delivered = false;
				reason = "missing_seed";
				break;
			}

			const alreadyPlanned = plannedDistribution.get(seedId) ?? 0;
			const availableSupply = snapshot.maxSupply === 0
				? Number.POSITIVE_INFINITY
				: snapshot.maxSupply - snapshot.distributed - alreadyPlanned;

			if (availableSupply < 1) {
				delivered = false;
				reason = "insufficient_supply";
				break;
			}

			if (reservationBySeed) {
				const reserved = reservationBySeed.get(seedId) ?? 0;
				const alreadyReserved = plannedReservationConsumption.get(seedId) ?? 0;
				if ((reserved - alreadyReserved) < 1) {
					delivered = false;
					reason = "insufficient_reservation";
					break;
				}
			}
		}

		selections.push({
			packIndex,
			selectedSeedIds,
			delivered,
			reason,
		});

		if (!delivered) continue;

		for (const seedId of selectedSeedIds) {
			const seed = seedsById.get(seedId);
			if (!seed) {
				throw new Error(`Missing seed snapshot after validation: ${seedId}`);
			}

			plannedDistribution.set(seedId, (plannedDistribution.get(seedId) ?? 0) + 1);
			plannedReservationConsumption.set(seedId, (plannedReservationConsumption.get(seedId) ?? 0) + 1);

			const current = itemsBySeed.get(seedId);
			if (current) {
				itemsBySeed.set(seedId, {
					...current,
					quantity: current.quantity + 1,
				});
				continue;
			}

			itemsBySeed.set(seedId, {
				seedId,
				seedTxId: seed.seedTxId,
				quantity: 1,
			});
		}
	}

	const deliveredPacks = selections.filter(selection => selection.delivered).length;
	const reservationConsumption: ReservationConsumption[] = Array.from(plannedReservationConsumption.entries()).map(
		([seedId, quantity]) => ({ seedId, quantity }),
	);

	return {
		deliveredPacks,
		skippedPacks: context.quantity - deliveredPacks,
		items: Array.from(itemsBySeed.values()),
		reservationConsumption,
		selections,
	};
}
