// Pure business rules for NFT operations.
// Zero I/O, zero side-effects — testable with plain values.

type NftType = "seed" | "instance";

export const resolveNftType = (
	explicitType: string | null,
	nftId: string,
): NftType => {
	if (explicitType === "seed") return "seed";
	if (!explicitType && nftId.startsWith("seed_")) return "seed";
	return "instance";
};

export const validateSeedCap = (
	collectionId: string,
	seedCount: number,
	totalPotential: number,
): void => {
	if (totalPotential > 0 && seedCount >= totalPotential) {
		throw new Error(
			`Collection ${collectionId} reached its seed cap: ${seedCount}/${totalPotential}`,
		);
	}
};

export const computeExpectedTransferCount = (split: {
	readonly sellerAmount: number;
	readonly royaltyAmount: number;
	readonly royaltyRecipient: string | null;
	readonly feeAmount: number;
}): number => {
	let count = 0;
	if (split.sellerAmount > 0) count++;
	if (split.royaltyAmount > 0 && split.royaltyRecipient) count++;
	if (split.feeAmount > 0) count++;
	return count;
};

export const validateTransferCount = (
	transfers: ReadonlyArray<unknown>,
	split: {
		readonly sellerAmount: number;
		readonly royaltyAmount: number;
		readonly royaltyRecipient: string | null;
		readonly feeAmount: number;
	},
): void => {
	const expected = computeExpectedTransferCount(split);
	if (transfers.length !== expected) {
		throw new Error(
			`Expected exactly ${expected} transfers, got ${transfers.length}`,
		);
	}
};

type SeedDemandResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; error: string }>;

export const validateSeedDemand = (params: {
	readonly seedId: string;
	readonly weight: number;
	readonly totalWeight: number;
	readonly maxReplicas: number;
	readonly distributed: number;
	readonly maxSupply: number;
	readonly itemsPerPack: number;
}): SeedDemandResult => {
	const { seedId, weight, totalWeight, maxReplicas, distributed, maxSupply, itemsPerPack } = params;

	if (maxSupply > 0) {
		const totalDemand = maxSupply * itemsPerPack;
		const expectedDemand = Math.ceil((totalDemand * weight) / totalWeight);
		const remaining = maxReplicas > 0 ? maxReplicas - distributed : Infinity;

		if (maxReplicas > 0 && remaining < expectedDemand) {
			return {
				ok: false,
				error: `Seed ${seedId} needs ~${expectedDemand} remaining supply but has ${remaining}`,
			};
		}
	} else if (maxReplicas > 0) {
		return {
			ok: false,
			error: `Unlimited pack requires unlimited seeds, but ${seedId} has max_replicas=${maxReplicas}`,
		};
	}

	return { ok: true };
};

export const computeInstanceBaseline = (
	distributed: number,
	alreadyMintedThisTx: number,
): number => distributed - alreadyMintedThisTx;

export const validatePackPayment = (params: {
	readonly transfers: ReadonlyArray<{ readonly from: string; readonly to: string; readonly amount: number; readonly currency: string }>;
	readonly buyer: string;
	readonly creator: string;
	readonly pricePerUnit: number;
	readonly currency: string;
	readonly quantity: number;
}): void => {
	const { transfers, buyer, creator, pricePerUnit, currency, quantity } = params;

	if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
		throw new Error(`Pack has invalid price: ${pricePerUnit}`);
	}

	// Integer arithmetic to avoid floating-point precision issues (Hive uses 3 decimal places)
	const priceMillis = Math.round(pricePerUnit * 1000);
	const expectedMillis = priceMillis * quantity;

	const payment = transfers.find(t =>
		t.from === buyer &&
		t.to === creator &&
		t.currency === currency &&
		Math.round(t.amount * 1000) >= expectedMillis
	);

	if (!payment) {
		const expectedTotal = expectedMillis / 1000;
		throw new Error(
			`Invalid payment: expected >= ${expectedTotal} ${currency} from @${buyer} to @${creator}`,
		);
	}
};

export const validateSeedSupplyForDistribution = (
	seedId: string,
	maxReplicas: number,
	baseDistributed: number,
	requestedQuantity: number,
): void => {
	if (maxReplicas > 0 && baseDistributed + requestedQuantity > maxReplicas) {
		throw new Error(
			`Seed ${seedId} insufficient supply: needs ${requestedQuantity}, available ${maxReplicas - baseDistributed}`,
		);
	}
};
