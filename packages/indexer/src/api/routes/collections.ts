import { Elysia, t } from "elysia";
import {
	listCollections,
	getCollectionById,
	getCollectionsByCreator,
	getCollectionStats,
} from "@/db/queries/collections.ts";
import { queryNfts, parseNftKind } from "@/db/queries/nfts.ts";

export const collectionsRoutes = new Elysia({ prefix: "/api/collections", tags: ["Collections"] })
	.get("/", async ({ query }) => {
		const rows = query.creator
			? await getCollectionsByCreator(query.creator, query.limit, query.offset)
			: await listCollections(query.limit, query.offset);
		return rows;
	}, {
		query: t.Object({
			creator: t.Optional(t.String({ description: "Filter by creator Hive username" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "List collections", description: "Returns paginated list of collections. Optionally filter by creator." },
	})
	.get("/:id", async ({ params }) => {
		const row = await getCollectionById(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "Collection not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get collection by ID" },
	})
	.get("/:id/nfts", async ({ params, query }) => {
		const row = await getCollectionById(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "Collection not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return queryNfts(
			{ by: "collection", collectionId: params.id, type: parseNftKind(query.type) },
			{ limit: query.limit, offset: query.offset },
		);
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
		const row = await getCollectionById(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "Collection not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		const stats = await getCollectionStats(params.id);
		return stats ?? {};
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get collection statistics", description: "Aggregated stats: seeds, instances, replicas, listed, burned, unique owners, floor price" },
	});
