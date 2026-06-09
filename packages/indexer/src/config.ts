import {
  DEFAULT_FEE_ACCOUNT,
  PROTOCOL_GENESIS_BLOCK,
  PROTOCOL_ID,
  validateGenesisBlockSelection,
} from "@/protocol/index.ts";

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
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
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
    throw new Error(
      `Invalid INDEXER_ROLE: "${role}". Must be sync | api | both`,
    );
  }
  return role as IndexerRole;
};

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
type LogLevel = "debug" | "info" | "warn" | "error";

const toLogLevel = (val: string | undefined, fallback: LogLevel): LogLevel => {
  if (val && LOG_LEVELS.has(val)) return val as LogLevel;
  return fallback;
};

const VALID_DATABASE_MODES = new Set(["auto", "internal", "external"] as const);

export type DatabaseMode = "auto" | "internal" | "external";
export type ResolvedDatabaseMode = Exclude<DatabaseMode, "auto">;
export type DatabaseConfigSource = "url" | "parts" | "dev-default";

export interface ResolvedDatabaseConfig {
  readonly mode: ResolvedDatabaseMode;
  readonly source: DatabaseConfigSource;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly shouldAutoStartLocalPostgres: boolean;
}

const DEFAULT_DATABASE_PORT = 5432;
const DEFAULT_DATABASE_NAME = "nftlox_indexer";
const DEFAULT_DATABASE_USER = "nftlox";
const DEFAULT_DEV_DATABASE_PASSWORD = "nftlox_dev";

function toDatabaseMode(val: string | undefined): DatabaseMode {
  const mode = val?.trim() || "auto";
  if (!VALID_DATABASE_MODES.has(mode as DatabaseMode)) {
    throw new Error(
      `Invalid DATABASE_MODE: "${mode}". Must be auto | internal | external`,
    );
  }
  return mode as DatabaseMode;
}

function parseDatabaseUrl(urlValue: string): {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid postgres:// or postgresql:// URL",
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      "DATABASE_URL must use the postgres:// or postgresql:// protocol",
    );
  }

  if (!parsed.hostname) {
    throw new Error("DATABASE_URL must include a hostname");
  }

  const port = parsed.port === "" ? DEFAULT_DATABASE_PORT : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DATABASE_URL must include a valid port");
  }

  const database = parsed.pathname.replace(/^\/+/, "");
  if (!database) {
    throw new Error("DATABASE_URL must include a database name");
  }

  return {
    host: parsed.hostname,
    port,
    database,
    user: decodeURIComponent(parsed.username),
  };
}

function buildDatabaseUrl(parts: {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}): string {
  const url = new URL("postgres://placeholder");
  url.hostname = parts.host;
  url.port = String(parts.port);
  url.pathname = `/${parts.database}`;
  url.username = parts.user;
  if (parts.password !== "") {
    url.password = parts.password;
  }
  return url.toString();
}

export function resolveDatabaseConfig(
  env: NodeJS.ProcessEnv,
): ResolvedDatabaseConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const databaseMode = toDatabaseMode(env.DATABASE_MODE);
  const rawDatabaseUrl = env.DATABASE_URL?.trim() ?? "";

  if (
    databaseMode === "external" ||
    (databaseMode === "auto" && rawDatabaseUrl !== "")
  ) {
    if (rawDatabaseUrl === "") {
      throw new Error("DATABASE_MODE=external requires DATABASE_URL to be set");
    }
    const parsed = parseDatabaseUrl(rawDatabaseUrl);
    return {
      mode: "external",
      source: "url",
      url: rawDatabaseUrl,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      shouldAutoStartLocalPostgres: false,
    };
  }

  const host =
    env.POSTGRES_HOST?.trim() ||
    (nodeEnv === "production" ? "postgres" : "localhost");
  const port = toBoundedInt(
    env.POSTGRES_PORT,
    DEFAULT_DATABASE_PORT,
    1,
    65_535,
  );
  const database = env.POSTGRES_DB?.trim() || DEFAULT_DATABASE_NAME;
  const user = env.POSTGRES_USER?.trim() || DEFAULT_DATABASE_USER;
  const password =
    env.POSTGRES_PASSWORD ??
    (nodeEnv === "production" ? "" : DEFAULT_DEV_DATABASE_PASSWORD);
  const source: DatabaseConfigSource =
    env.POSTGRES_HOST ||
    env.POSTGRES_PORT ||
    env.POSTGRES_DB ||
    env.POSTGRES_USER ||
    env.POSTGRES_PASSWORD
      ? "parts"
      : "dev-default";

  if (nodeEnv === "production" && password === "") {
    throw new Error(
      "POSTGRES_PASSWORD must be set when using the internal PostgreSQL configuration in production",
    );
  }

  return {
    mode: "internal",
    source,
    url: buildDatabaseUrl({ host, port, database, user, password }),
    host,
    port,
    database,
    user,
    shouldAutoStartLocalPostgres:
      nodeEnv !== "production" && host === "localhost",
  };
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const database = resolveDatabaseConfig(process.env);

// Fields whose values are credentials or embed credentials. Any
// whole-config serialization (JSON.stringify, console.log, logger data
// payloads) must replace these with a placeholder so an accidental log
// never exposes production secrets. Added here so a future sensitive
// field is redacted the moment it is introduced — changing the set is a
// single-line audit trail.
const SENSITIVE_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  "postgresPassword",
  "databaseUrl",
]);
const REDACTED = "[REDACTED]";
// Cross-runtime access to Node/Bun's custom inspect hook without importing
// `node:util` (keeps this file runtime-neutral). `Symbol.for` returns the
// same global symbol both runtimes check when `console.log` or
// `util.inspect` unwraps a value.
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

export const config = {
  port: toInt(process.env.INDEXER_PORT, 3050),
  databaseUrl: database.url,
  databaseMode: database.mode,
  databaseConfigSource: database.source,
  databaseHost: database.host,
  databasePort: database.port,
  databaseName: database.database,
  databaseUser: database.user,
  shouldAutoStartLocalPostgres: database.shouldAutoStartLocalPostgres,
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
  hiveEndpoints: (
    process.env.HIVE_ENDPOINTS ?? "https://api.syncad.com,https://api.hive.blog"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Security
  nodeEnv,
  enableSwagger: toBool(process.env.ENABLE_SWAGGER, nodeEnv !== "production"),
  healthPort: toInt(process.env.HEALTH_PORT, 0),
  postgresPassword:
    process.env.POSTGRES_PASSWORD ??
    (nodeEnv === "production" ? "" : DEFAULT_DEV_DATABASE_PASSWORD),
  postgresUser: process.env.POSTGRES_USER ?? database.user,
  postgresDb: process.env.POSTGRES_DB ?? database.database,
  // Cuenta del nodo: firma operaciones y recibe el fee del protocolo en ventas.
  hiveAccount: process.env.HIVE_ACCOUNT ?? DEFAULT_FEE_ACCOUNT,
  indexerRole: toIndexerRole(process.env.INDEXER_ROLE),
  // Node public info
  nodeUrl: process.env.NODE_URL ?? "",
  // Public-directory opt-in. When true, the startup routine imports POSTING_KEY
  // into beekeeper, the node emits `node_register`, and a background job emits
  // `node_heartbeat` every MIN_HEARTBEAT_INTERVAL_BLOCKS.
  // When false, the node indexes + serves privately and never touches the
  // public `l2_nodes` directory — a valid, first-class configuration.
  nodeRegister: toBool(process.env.NODE_REGISTER, false),
  // Multisig (buy + create_collection transaction signing)
  // NOTE: ACTIVE_KEY, POSTING_KEY, and BEEKEEPER_PASSWORD are read directly
  // from process.env at startup (monolith.ts / api.ts), never stored in
  // config — prevents the WIFs from lingering in V8 heap as frozen strings
  // after beekeeper import.
  multisigRateLimitMax: toInt(process.env.MULTISIG_RATE_LIMIT_MAX, 10),
  multisigRateLimitWindowMs: toInt(
    process.env.MULTISIG_RATE_LIMIT_WINDOW_MS,
    60_000,
  ),
  multisigIpRateLimitMax: toInt(process.env.MULTISIG_IP_RATE_LIMIT_MAX, 30),
  multisigIpRateLimitWindowMs: toInt(
    process.env.MULTISIG_IP_RATE_LIMIT_WINDOW_MS,
    60_000,
  ),
  multisigPowBits: toBoundedInt(process.env.MULTISIG_POW_BITS, 10, 0, 24),
  multisigPowTtlMs: toBoundedInt(
    process.env.MULTISIG_POW_TTL_MS,
    300_000,
    1_000,
    3_600_000,
  ),
  multisigPowMaxFutureSkewMs: toBoundedInt(
    process.env.MULTISIG_POW_MAX_FUTURE_SKEW_MS,
    30_000,
    0,
    300_000,
  ),
  multisigPowReplayCacheMax: toBoundedInt(
    process.env.MULTISIG_POW_REPLAY_CACHE_MAX,
    10_000,
    1,
    1_000_000,
  ),
} as const;

// ---------------------------------------------------------------------------
// Credential redaction on serialization.
//
// `config` is a module-global imported by ~20 files. A future log line
// like `log.info("starting", { config })` would dump `postgresPassword`
// and the userinfo-embedded password inside `databaseUrl` straight to
// stdout. Consumers that need the real values read the fields directly
// (unchanged behavior); any *serialized* view replaces credentials with
// a placeholder.
//
// Two hooks cover the common leak paths:
//   - `toJSON`              — `JSON.stringify(config)` (logger uses this)
//   - `util.inspect.custom` — `console.log(config)` / `util.inspect(config)`
//
// `toJSON` is intentionally enumerable: Bun's JSON.stringify diverges from
// the ECMAScript spec and does not invoke a non-enumerable `toJSON`. Making
// it enumerable is the cost of cross-runtime-safe redaction. `buildRedacted
// ConfigSnapshot` skips the `toJSON` key so the function itself never shows
// up in the serialized payload. `util.inspect.custom` is symbol-keyed, so
// staying non-enumerable is spec-and-Bun-safe there.
// ---------------------------------------------------------------------------
function buildRedactedConfigSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "toJSON") continue;
    snapshot[key] = SENSITIVE_CONFIG_FIELDS.has(key) ? REDACTED : value;
  }
  return snapshot;
}

Object.defineProperty(config, "toJSON", {
  value: buildRedactedConfigSnapshot,
  enumerable: true,
  configurable: false,
  writable: false,
});

Object.defineProperty(config, INSPECT_CUSTOM, {
  value: buildRedactedConfigSnapshot,
  enumerable: false,
  configurable: false,
  writable: false,
});

validateGenesisBlockSelection({ genesisBlock: config.genesisBlock });

if (config.hiveEndpoints.length === 0) {
  throw new Error("HIVE_ENDPOINTS must contain at least one valid URL");
}

if (!config.hiveAccount) {
  throw new Error("HIVE_ACCOUNT must be a valid non-empty account name");
}

// API roles expose multisig signing endpoints. They require ACTIVE_KEY for
// node co-signing. POSTING_KEY is only needed when the node also emits public
// directory operations (node_register / node_heartbeat).
const servesSigningApi =
  config.indexerRole === "api" || config.indexerRole === "both";
if (servesSigningApi && !process.env.ACTIVE_KEY) {
  throw new Error(
    `INDEXER_ROLE=${config.indexerRole} serves signing endpoints and requires ACTIVE_KEY — set ACTIVE_KEY in your .env, or switch INDEXER_ROLE=sync if this node should not serve the API`,
  );
}
if (config.nodeRegister && !process.env.POSTING_KEY) {
  throw new Error(
    "NODE_REGISTER=true requires POSTING_KEY — set POSTING_KEY (the hive account's posting WIF) in your .env, or switch NODE_REGISTER=false if this node should stay private",
  );
}

if (config.nodeEnv === "production") {
  if (config.databaseMode === "external" && !process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_MODE=external requires DATABASE_URL to be set in production",
    );
  }
  if (config.databaseMode === "internal" && !process.env.POSTGRES_PASSWORD) {
    throw new Error(
      "POSTGRES_PASSWORD must be set in production when using the internal PostgreSQL service",
    );
  }
}

export type Config = typeof config;
