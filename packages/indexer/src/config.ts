const toInt = (val: string | undefined, fallback: number): number => {
	const parsed = Number(val);
	return Number.isNaN(parsed) ? fallback : parsed;
};

export const config = {
	port: toInt(process.env.INDEXER_PORT, 3050),
	databaseUrl: process.env.DATABASE_URL ?? "postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer",
	genesisBlock: toInt(process.env.GENESIS_BLOCK, 90_000_000),
	protocolId: process.env.PROTOCOL_ID ?? "nftlox_testnet",
	batchSize: toInt(process.env.BATCH_SIZE, 1000),
	syncIntervalMs: toInt(process.env.SYNC_INTERVAL_MS, 3000),
	logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
	hiveEndpoints: [
		"https://api.hive.blog",
		"https://api.openhive.network",
		"https://techcoderx.com",
	],
} as const;

export type Config = typeof config;
