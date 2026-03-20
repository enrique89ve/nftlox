const toInt = (val: string | undefined, fallback: number): number => {
	const parsed = Number(val);
	return Number.isNaN(parsed) ? fallback : parsed;
};

const toBool = (val: string | undefined, fallback: boolean): boolean => {
	if (val === undefined) return fallback;
	return val === "true" || val === "1";
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
	genesisBlock: toInt(process.env.GENESIS_BLOCK, 90_000_000),
	protocolId: process.env.PROTOCOL_ID ?? "nftlox_testnet",
	batchSize: toInt(process.env.BATCH_SIZE, 1000),
	syncIntervalMs: toInt(process.env.SYNC_INTERVAL_MS, 3000),
	logLevel: toLogLevel(process.env.LOG_LEVEL, "info"),
	hiveEndpoints: [
		"https://api.hive.blog",
		"https://api.openhive.network",
		"https://techcoderx.com",
	],
	// Security
	nodeEnv: process.env.NODE_ENV ?? "development",
	enableSwagger: toBool(process.env.ENABLE_SWAGGER, process.env.NODE_ENV !== "production"),
	postgresPassword: process.env.POSTGRES_PASSWORD ?? "nftlox_dev",
	postgresUser: process.env.POSTGRES_USER ?? "nftlox",
	postgresDb: process.env.POSTGRES_DB ?? "nftlox_indexer",
} as const;

export type Config = typeof config;
