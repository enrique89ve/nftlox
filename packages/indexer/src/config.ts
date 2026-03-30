import { DEFAULT_FEE_ACCOUNT } from "nftlox-sdk";

const toInt = (val: string | undefined, fallback: number): number => {
	const parsed = Number(val);
	return Number.isNaN(parsed) ? fallback : parsed;
};

const toBool = (val: string | undefined, fallback: boolean): boolean => {
	if (val === undefined) return fallback;
	return val === "true" || val === "1";
};

const VALID_ROLES = new Set(["sync", "api", "both"] as const);
type IndexerRole = "sync" | "api" | "both";

const toIndexerRole = (val: string | undefined): IndexerRole => {
	const role = val ?? "both";
	if (!VALID_ROLES.has(role as IndexerRole)) {
		throw new Error(`Invalid INDEXER_ROLE: "${role}". Must be sync | api | both`);
	}
	return role as IndexerRole;
};

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
type LogLevel = "debug" | "info" | "warn" | "error";

const toLogLevel = (val: string | undefined, fallback: LogLevel): LogLevel => {
	if (val !== undefined && LOG_LEVELS.has(val)) return val as LogLevel;
	return fallback;
};

export const config = {
	port: toInt(process.env.INDEXER_PORT, 3050),
	databaseUrl: process.env.DATABASE_URL ?? "postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer",
	genesisBlock: toInt(process.env.GENESIS_BLOCK, 0),
	protocolId: process.env.PROTOCOL_ID ?? "nftlox_testnet",
	batchSize: toInt(process.env.BATCH_SIZE, 1000),
	syncIntervalMs: toInt(process.env.SYNC_INTERVAL_MS, 3000),
	logLevel: toLogLevel(process.env.LOG_LEVEL, "info"),
	// Only endpoints with HafAH support (required for sync)
	// Order: fastest-responding first (api.hive.blog often timeouts in Docker)
	hiveEndpoints: (process.env.HIVE_ENDPOINTS ?? "https://api.syncad.com,https://rpc.mahdiyari.info,https://api.hive.blog").split(",").map(s => s.trim()).filter(Boolean),
	// Security
	nodeEnv: process.env.NODE_ENV ?? "development",
	enableSwagger: toBool(process.env.ENABLE_SWAGGER, process.env.NODE_ENV !== "production"),
	healthPort: toInt(process.env.HEALTH_PORT, 0),
	postgresPassword: process.env.POSTGRES_PASSWORD ?? "nftlox_dev",
	postgresUser: process.env.POSTGRES_USER ?? "nftlox",
	postgresDb: process.env.POSTGRES_DB ?? "nftlox_indexer",
	// Cuenta del nodo: firma operaciones y recibe el fee 2.5% en ventas.
	hiveAccount: process.env.HIVE_ACCOUNT ?? DEFAULT_FEE_ACCOUNT,
	indexerRole: toIndexerRole(process.env.INDEXER_ROLE),
	// Node public info
	nodeUrl: process.env.NODE_URL ?? "",
	// Multisig (buy transaction signing)
	activeKey: process.env.ACTIVE_KEY ?? "",
	multisigRateLimitMax: toInt(process.env.MULTISIG_RATE_LIMIT_MAX, 10),
	multisigRateLimitWindowMs: toInt(process.env.MULTISIG_RATE_LIMIT_WINDOW_MS, 60_000),
} as const;

if (!config.genesisBlock) {
	throw new Error("GENESIS_BLOCK env var is required");
}

if (config.hiveEndpoints.length === 0) {
	throw new Error("HIVE_ENDPOINTS must contain at least one valid URL");
}

if (!config.hiveAccount) {
	throw new Error("HIVE_ACCOUNT must be a valid non-empty account name");
}

if (config.nodeEnv === "production" && process.env.POSTGRES_PASSWORD === undefined) {
	throw new Error("POSTGRES_PASSWORD must be set in production");
}

export type Config = typeof config;
