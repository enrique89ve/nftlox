import { DEFAULT_FEE_ACCOUNT, PROTOCOL_GENESIS_BLOCK, PROTOCOL_ID } from "@/protocol/index.ts";
import { validateGenesisBlockSelection } from "@/protocol/genesis-guard.ts";

const toInt = (val: string | undefined, fallback: number): number => {
	if (val === undefined || val === "") return fallback;
	const parsed = Number(val);
	return Number.isNaN(parsed) ? fallback : parsed;
};

const toBoundedInt = (
	val: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number => {
	const parsed = toInt(val, fallback);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const toBool = (val: string | undefined, fallback: boolean): boolean => {
	if (val === undefined || val === "") return fallback;
	return val === "true" || val === "1";
};

const VALID_ROLES = new Set(["sync", "api", "both"] as const);
type IndexerRole = "sync" | "api" | "both";

const toIndexerRole = (val: string | undefined): IndexerRole => {
	const role = val || "both";
	if (!VALID_ROLES.has(role as IndexerRole)) {
		throw new Error(`Invalid INDEXER_ROLE: "${role}". Must be sync | api | both`);
	}
	return role as IndexerRole;
};

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
type LogLevel = "debug" | "info" | "warn" | "error";

const toLogLevel = (val: string | undefined, fallback: LogLevel): LogLevel => {
	if (val && LOG_LEVELS.has(val)) return val as LogLevel;
	return fallback;
};

export const config = {
	port: toInt(process.env.INDEXER_PORT, 3050),
	databaseUrl: process.env.DATABASE_URL ?? (process.env.NODE_ENV === "production" ? "" : "postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer"),
	// Genesis is a protocol invariant. Intentionally NOT read from env: the only
	// legitimate "override" is editing the constant — protocol-auth.test guards
	// that from drifting out of sync with the SDK.
	genesisBlock: PROTOCOL_GENESIS_BLOCK,
	protocolId: PROTOCOL_ID,
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
	postgresPassword: process.env.POSTGRES_PASSWORD ?? (process.env.NODE_ENV === "production" ? "" : "nftlox_dev"),
	postgresUser: process.env.POSTGRES_USER ?? (process.env.NODE_ENV === "production" ? "" : "nftlox"),
	postgresDb: process.env.POSTGRES_DB ?? (process.env.NODE_ENV === "production" ? "" : "nftlox_indexer"),
	// Cuenta del nodo: firma operaciones y recibe el fee del protocolo en ventas.
	hiveAccount: process.env.HIVE_ACCOUNT ?? DEFAULT_FEE_ACCOUNT,
	indexerRole: toIndexerRole(process.env.INDEXER_ROLE),
	// Node public info
	nodeUrl: process.env.NODE_URL ?? "",
	// Public-directory opt-in. When true, the startup routine imports POSTING_KEY
	// into beekeeper, the node emits `node_register` once its HP is ≥ threshold,
	// and a background job emits `node_heartbeat` every MIN_HEARTBEAT_INTERVAL_BLOCKS.
	// When false, the node indexes + serves privately and never touches the
	// public `l2_nodes` directory — a valid, first-class configuration.
	nodeRegister: toBool(process.env.NODE_REGISTER, false),
	// Multisig (buy transaction signing)
	// NOTE: ACTIVE_KEY, POSTING_KEY, and BEEKEEPER_PASSWORD are read directly from
	// process.env at startup (monolith.ts / api.ts), never stored in config —
	// prevents the WIFs from lingering in V8 heap as frozen strings after beekeeper
	// import.
	multisigRateLimitMax: toInt(process.env.MULTISIG_RATE_LIMIT_MAX, 10),
	multisigRateLimitWindowMs: toInt(process.env.MULTISIG_RATE_LIMIT_WINDOW_MS, 60_000),
	multisigIpRateLimitMax: toInt(process.env.MULTISIG_IP_RATE_LIMIT_MAX, 30),
	multisigIpRateLimitWindowMs: toInt(process.env.MULTISIG_IP_RATE_LIMIT_WINDOW_MS, 60_000),
	multisigPowBits: toBoundedInt(process.env.MULTISIG_POW_BITS, 10, 0, 24),
	multisigPowTtlMs: toBoundedInt(process.env.MULTISIG_POW_TTL_MS, 300_000, 1_000, 3_600_000),
	multisigPowMaxFutureSkewMs: toBoundedInt(process.env.MULTISIG_POW_MAX_FUTURE_SKEW_MS, 30_000, 0, 300_000),
	multisigPowReplayCacheMax: toBoundedInt(process.env.MULTISIG_POW_REPLAY_CACHE_MAX, 10_000, 1, 1_000_000),
} as const;

validateGenesisBlockSelection({ genesisBlock: config.genesisBlock });

if (config.hiveEndpoints.length === 0) {
	throw new Error("HIVE_ENDPOINTS must contain at least one valid URL");
}

if (!config.hiveAccount) {
	throw new Error("HIVE_ACCOUNT must be a valid non-empty account name");
}

if (config.nodeRegister && !process.env.POSTING_KEY) {
	throw new Error(
		"NODE_REGISTER=true requires POSTING_KEY — set POSTING_KEY (the hive account's posting WIF) in your .env, or set NODE_REGISTER=false to run the node privately without public-directory registration",
	);
}

if (config.nodeEnv === "production") {
	if (!process.env.DATABASE_URL) {
		throw new Error("DATABASE_URL must be set in production");
	}
	if (!process.env.POSTGRES_PASSWORD) {
		throw new Error("POSTGRES_PASSWORD must be set in production");
	}
}

export type Config = typeof config;
