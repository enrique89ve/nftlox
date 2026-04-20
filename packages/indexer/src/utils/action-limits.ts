/** Dimension sobre la que se mide el limite. */
export type LimitDimension =
	| "collectionsPerCreator"
	| "seedsPerCreator"
	| "instancesPerCreator";

/** Proveedor de limites — reemplazable por strategy (e.g., creditos, DB, plan). */
export type ActionLimitsProvider = {
	getLimit(dimension: LimitDimension, scopeKey: string): Promise<number> | number;
};

const DEFAULT_LIMITS: Record<LimitDimension, number> = {
	collectionsPerCreator: 50,
	seedsPerCreator: 3_000,
	instancesPerCreator: 3_000_000,
};

const constantLimitsProvider: ActionLimitsProvider = {
	getLimit: (dimension: LimitDimension) => DEFAULT_LIMITS[dimension],
};

let activeProvider: ActionLimitsProvider = constantLimitsProvider;

export function setLimitsProvider(provider: ActionLimitsProvider): void {
	activeProvider = provider;
}

/**
 * Asserts that adding `increment` items would not exceed the configured limit
 * for a dimension. Throws if it would. A limit of 0 means unlimited.
 *
 * `increment` defaults to 1 for single-item operations (mint). Batch operations
 * (bulk_distribute) pass the planned quantity so the check is applied once
 * against the aggregate, not per-item.
 */
export async function assertWithinLimit(
	dimension: LimitDimension,
	scopeKey: string,
	currentCount: number,
	increment = 1,
): Promise<void> {
	const max = await activeProvider.getLimit(dimension, scopeKey);
	if (max > 0 && currentCount + increment > max) {
		throw new Error(
			`Limit reached for ${dimension} (${scopeKey}): ${currentCount + increment}/${max}`,
		);
	}
}
