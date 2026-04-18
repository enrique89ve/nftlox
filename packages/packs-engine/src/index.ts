import * as constants from "./constants";
import * as rng from "./rng";
import * as packDefinition from "./pack-definition";
import * as openPlan from "./open-plan";

export type {
	PackDropEntry,
	PackDefinitionInput,
	PackDefinition,
	SeedSupplySnapshot,
	ReservationDemand,
	PackOpenContext,
	PackSkipReason,
	PackSelection,
	ReservationConsumption,
	PackOpenPlan,
} from "./types";

export const MAX_DROP_TABLE_ENTRIES = constants.MAX_DROP_TABLE_ENTRIES;
export const MAX_ITEMS_PER_PACK = constants.MAX_ITEMS_PER_PACK;
export const MAX_PACK_OPEN_BATCH = constants.MAX_PACK_OPEN_BATCH;
export const MIN_DROP_WEIGHT = constants.MIN_DROP_WEIGHT;
export const MAX_DROP_WEIGHT = constants.MAX_DROP_WEIGHT;

export const generateDeterministicPackId = rng.generateDeterministicPackId;
export const isPackId = rng.isPackId;
export const deterministicRng = rng.deterministicRng;
export const resolveDropTable = rng.resolveDropTable;
export const buildPackOpenSeed = rng.buildPackOpenSeed;

export const assertValidPackDefinition = packDefinition.assertValidPackDefinition;
export const createPackDefinition = packDefinition.createPackDefinition;
export const computeReservedSupply = packDefinition.computeReservedSupply;
export const validateReservationDemand = packDefinition.validateReservationDemand;

export const selectPackSeedIds = openPlan.selectPackSeedIds;
export const buildPackOpenPlan = openPlan.buildPackOpenPlan;
