const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;

	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;

	return fallback;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

export const playgroundConfig = {
	nodeEnv,
	isProduction,
	// Debug signing helpers are opt-in outside production and never exposed in production.
	debugRoutesEnabled: !isProduction && parseBoolean(process.env.ENABLE_DEBUG_ROUTES, false),
} as const;
