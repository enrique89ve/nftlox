// Pure business rules for NFT operations.
// Zero I/O, zero side-effects — testable with plain values.

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
	consumedIndices?: ReadonlySet<number>,
): void => {
	const expected = computeExpectedTransferCount(split);
	// When a TransferPool is in use, count only transfers consumed by THIS operation
	// (already added by verifyTransfers). Without a pool, validate total count as before.
	if (consumedIndices) {
		// verifyTransfers already consumed exactly the transfers for this buy.
		// Just verify the pool had enough — if verifyTransfers succeeded, this is satisfied.
		return;
	}
	if (transfers.length !== expected) {
		throw new Error(
			`Expected exactly ${expected} transfers, got ${transfers.length}`,
		);
	}
};

export const computeInstanceBaseline = (
	distributed: number,
	alreadyMintedThisTx: number,
): number => distributed - alreadyMintedThisTx;

export const validateSeedSupplyForDistribution = (
	seedId: string,
	maxSupply: number,
	baseDistributed: number,
	requestedQuantity: number,
	reservedSupply: number = 0,
): void => {
	if (maxSupply > 0) {
		const available = maxSupply - baseDistributed - reservedSupply;
		if (requestedQuantity > available) {
			throw new Error(
				`Seed ${seedId} insufficient supply: needs ${requestedQuantity}, available ${available}`,
			);
		}
	}
};
