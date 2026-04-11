import type { BulkDistributeItem, Price } from "nftlox-sdk";

export interface PackDropEntry {
	readonly seedId: string;
	readonly weight: number;
}

export interface PackDefinitionInput {
	readonly collectionId: string;
	readonly name: string;
	readonly description?: string;
	readonly imageUrl?: string;
	readonly dropTable: readonly PackDropEntry[];
	readonly itemsPerPack: number;
	readonly price?: Price;
	readonly maxSupply: number;
}

export interface PackDefinition extends PackDefinitionInput {
	readonly id: string;
}

export interface SeedSupplySnapshot {
	readonly seedId: string;
	readonly seedTxId: string;
	readonly maxSupply: number;
	readonly distributed: number;
	readonly reserved: number;
}

export interface ReservationDemand {
	readonly seedId: string;
	readonly reserved: number;
	readonly remainingBefore: number | null;
	readonly remainingAfter: number | null;
}

export interface PackOpenContext {
	readonly txId: string;
	readonly operationId: string;
	readonly blockNum: number;
	readonly owner: string;
	readonly quantity: number;
}

export type PackSkipReason =
	| "missing_seed"
	| "insufficient_supply"
	| "insufficient_reservation";

export interface PackSelection {
	readonly packIndex: number;
	readonly selectedSeedIds: readonly string[];
	readonly delivered: boolean;
	readonly reason: PackSkipReason | null;
}

export interface ReservationConsumption {
	readonly seedId: string;
	readonly quantity: number;
}

export interface PackOpenPlan {
	readonly deliveredPacks: number;
	readonly skippedPacks: number;
	readonly items: readonly BulkDistributeItem[];
	readonly reservationConsumption: readonly ReservationConsumption[];
	readonly selections: readonly PackSelection[];
}
