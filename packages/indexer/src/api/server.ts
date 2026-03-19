import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { config } from "../config.ts";
import { createLogger } from "../utils/logger.ts";
import { collectionsRoutes } from "./routes/collections.ts";
import { nftsRoutes } from "./routes/nfts.ts";
import { usersRoutes } from "./routes/users.ts";
import { marketplaceRoutes } from "./routes/marketplace.ts";
import { statusRoutes } from "./routes/status.ts";

const log = createLogger("api");

export function startApiServer(): void {
	new Elysia()
		.use(cors())
		.use(swagger({
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
				],
			},
		}))
		.use(collectionsRoutes)
		.use(nftsRoutes)
		.use(usersRoutes)
		.use(marketplaceRoutes)
		.use(statusRoutes)
		.listen(config.port);

	log.info(`API server listening on port ${config.port}`);
	log.info(`Swagger UI: http://localhost:${config.port}/swagger`);
}
