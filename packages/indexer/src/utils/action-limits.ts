/** Dimension sobre la que se mide el limite. */
export type LimitDimension =
	| "collectionsPerCreator"
	| "packsPerCollection"
	| "seedsPerCollection";

/** Proveedor de limites — reemplazable por strategy (e.g., creditos, DB, plan). */
export type ActionLimitsProvider = {
	getLimit(dimension: LimitDimension, scopeKey: string): Promise<number> | number;
};

const DEFAULT_LIMITS: Record<LimitDimension, number> = {
	collectionsPerCreator: 100,
	packsPerCollection: 50,
	seedsPerCollection: 0, // 0 = delegado a totalPotential (per-collection)
};

const constantLimitsProvider: ActionLimitsProvider = {
	getLimit: (dimension: LimitDimension) => DEFAULT_LIMITS[dimension],
};

let activeProvider: ActionLimitsProvider = constantLimitsProvider;

export function setLimitsProvider(provider: ActionLimitsProvider): void {
	activeProvider = provider;
}

/**
 * Asserts that the current count is within the configured limit for a dimension.
 * Throws if the limit is reached. A limit of 0 means unlimited.
 */
export async function assertWithinLimit(
	dimension: LimitDimension,
	scopeKey: string,
	currentCount: number,
): Promise<void> {
	const max = await activeProvider.getLimit(dimension, scopeKey);
	if (max > 0 && currentCount >= max) {
		throw new Error(`Limit reached for ${dimension} (${scopeKey}): ${currentCount}/${max}`);
	}
}
