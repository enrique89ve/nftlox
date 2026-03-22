import { createLogger } from "./utils/logger.ts";
import { config } from "./config.ts";

const log = createLogger("router");

log.info(`Bootstrapping Indexer with role: ${config.indexerRole}`);

if (config.indexerRole === "sync") {
	await import("./sync.ts");
} else if (config.indexerRole === "api") {
	await import("./api.ts");
} else {
	await import("./monolith.ts");
}
