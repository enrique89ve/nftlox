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
import { checkRateLimit } from "./middleware/rate-limiter.ts";

const log = createLogger("api");

export function startApiServer(): void {
	const STATS_PATHS = new Set(["/api/stats", "/api/health"]);

	const app = new Elysia()
		.use(cors())
		.onBeforeHandle(({ request, set }) => {
			const blocked = checkRateLimit(request, set.headers);
			if (blocked) {
				set.status = 429;
				return blocked;
			}
		})
		.onAfterHandle(({ request, set }) => {
			set.headers["X-Content-Type-Options"] = "nosniff";
			set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";

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
		.listen(config.port);

	log.info(`API server listening on port ${config.port}`);
	if (config.enableSwagger) {
		log.info(`Swagger UI: http://localhost:${config.port}/swagger`);
	}
}
