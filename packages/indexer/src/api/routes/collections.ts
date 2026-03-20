import { Elysia, t } from "elysia";
import {
	listCollections,
	getCollectionById,
	getCollectionStats,
} from "@/db/queries/collections.ts";
import { getNftsByCollection } from "@/db/queries/nfts.ts";

export const collectionsRoutes = new Elysia({ prefix: "/api/collections", tags: ["Collections"] })
	.get("/", async ({ query }) => {
		const rows = await listCollections(query.limit, query.offset);
		return rows;
	}, {
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "List collections", description: "Returns paginated list of all collections with seed/instance counts" },
	})
	.get("/:id", async ({ params }) => {
		const row = await getCollectionById(params.id);
		if (!row) return new Response(JSON.stringify({ error: "Collection not found" }), { status: 404 });
		return row;
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get collection by ID" },
	})
	.get("/:id/nfts", async ({ params, query }) => {
		const rows = await getNftsByCollection(params.id, query.type, query.limit, query.offset);
		return rows;
	}, {
		params: t.Object({ id: t.String() }),
		query: t.Object({
			type: t.Optional(t.String({ description: "Filter by nft_type: seed, instance, replica" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "List NFTs in collection" },
	})
	.get("/:id/stats", async ({ params }) => {
		const stats = await getCollectionStats(params.id);
		return stats ?? {};
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get collection statistics", description: "Aggregated stats: seeds, instances, replicas, listed, burned, unique owners, floor price" },
	});
