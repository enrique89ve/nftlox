import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";
import { collectionsRoutes } from "./routes/collections.ts";
import { nftsRoutes } from "./routes/nfts.ts";
import { usersRoutes } from "./routes/users.ts";
import { marketplaceRoutes } from "./routes/marketplace.ts";
import { packsRoutes } from "./routes/packs.ts";
import { statusRoutes } from "./routes/status.ts";
import { multisigRoutes } from "./routes/multisig.ts";
import { checkRateLimit } from "./middleware/rate-limiter.ts";
import { getSyncStatus } from "@/db/queries/sync.ts";
import { isSynced as _isSynced, getSyncProgress } from "@/scanner/sync-state.ts";

const log = createLogger("api");

const isApiRole = config.indexerRole === "api";

let apiSynced = isApiRole ? false : _isSynced();
let apiLastBlock = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

if (isApiRole) {
	pollTimer = setInterval(async () => {
		try {
			const st = await getSyncStatus();
			apiLastBlock = st.lastBlock;
			apiSynced = st.updatedAt !== null && Date.now() - st.updatedAt.getTime() < 15_000;
		} catch (err) {
			log.warn("Sync polling failed", { error: err instanceof Error ? err.message : String(err) });
		}
	}, 2000);
}

export function stopPolling(): void {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

export function startApiServer(): void {
	const STATS_PATHS = new Set(["/api/stats", "/api/health"]);
	const ALLOWED_DURING_SYNC = new Set(["/api/health", "/api/status", "/swagger", "/swagger/json"]);

	const app = new Elysia()
		.use(cors())
		.onBeforeHandle(({ request, set }) => {
			// Rate limiting
			const rateLimited = checkRateLimit(request, set.headers);
			if (rateLimited) {
				set.status = 429;
				return rateLimited;
			}

			// Block data endpoints while syncing (allow health + status)
			const url = new URL(request.url);
			const currentSynced = isApiRole ? apiSynced : _isSynced();

			if (!currentSynced && !ALLOWED_DURING_SYNC.has(url.pathname)) {
				set.status = 503;
				set.headers["Retry-After"] = "30";
				const progress = getSyncProgress();
				return {
					error: "Indexer is syncing — data not yet available",
					lastBlock: isApiRole ? apiLastBlock : progress.lastBlock,
					headBlock: progress.headBlock,
					blocksBehind: isApiRole ? "unknown" : progress.behind,
				};
			}
		})
		.onAfterHandle(({ request, set }) => {
			set.headers["X-Content-Type-Options"] = "nosniff";
			set.headers["X-Frame-Options"] = "DENY";
			set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";

			const url = new URL(request.url);
			if (url.pathname.startsWith("/swagger")) {
				set.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;";
			} else {
				set.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
			}

			if (request.method !== "GET") return;

			const status = typeof set.status === "number" ? set.status : 200;
			if (status >= 400) {
				set.headers["Cache-Control"] = "no-store";
				return;
			}

			const url = new URL(request.url);
			const isStats = STATS_PATHS.has(url.pathname) || url.pathname.endsWith("/stats");
			set.headers["Cache-Control"] = `public, max-age=${isStats ? 10 : 2}`;
		});

	if (config.enableSwagger) {
		app.use(swagger({
			path: "/swagger",
			documentation: {
				info: {
					title: "NFTLox Indexer API",
					version: "0.1.0",
					description: "REST API for the NFTLox Protocol blockchain indexer. Provides queryable state for collections, NFTs, marketplace, and user activity on Hive blockchain.",
				},
				tags: [
					{ name: "Status", description: "Indexer sync status and protocol stats" },
					{ name: "Collections", description: "NFT collections" },
					{ name: "NFTs", description: "Individual NFTs (seeds, instances, replicas)" },
					{ name: "Users", description: "User portfolios and activity" },
					{ name: "Marketplace", description: "Listings and sales" },
					{ name: "Packs", description: "Semi-fungible packs (buy, transfer, open)" },
				],
			},
		}));
	}

	app
		.use(collectionsRoutes)
		.use(nftsRoutes)
		.use(usersRoutes)
		.use(marketplaceRoutes)
		.use(packsRoutes)
		.use(statusRoutes)
		.use(multisigRoutes)
		.listen({ port: config.port, idleTimeout: 30 });

	log.info(`API server listening on port ${config.port}`);
	if (config.enableSwagger) {
		log.info(`Swagger UI: http://localhost:${config.port}/swagger`);
	}
}
