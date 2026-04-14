export function sortKeysDeep(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (typeof value === "object") {
		const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

export function canonicalJson(data: Record<string, unknown>): string {
	return JSON.stringify(sortKeysDeep(data));
}
