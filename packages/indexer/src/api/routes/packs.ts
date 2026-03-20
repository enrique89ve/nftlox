import { Elysia, t } from "elysia";
import { listPacks, getPackById, getPackHistory } from "@/db/queries/packs.ts";

export const packsRoutes = new Elysia({ prefix: "/api/packs", tags: ["Packs"] })
	.get("/", async ({ query }) => {
		return listPacks(query.collectionId, query.limit, query.offset);
	}, {
		query: t.Object({
			collectionId: t.Optional(t.String({ description: "Filter by collection ID" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: {
			summary: "List packs",
			description: "Browse available packs, optionally filtered by collection",
		},
	})
	.get("/:id", async ({ params }) => {
		const pack = await getPackById(params.id);
		if (!pack) return new Response("Pack not found", { status: 404 });
		return pack;
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get pack by ID" },
	})
	.get("/:id/history", async ({ params, query }) => {
		return getPackHistory(params.id, query.limit, query.offset, query.cursor);
	}, {
		params: t.Object({ id: t.String() }),
		query: t.Object({
			limit: t.Number({ default: 100, minimum: 1, maximum: 500 }),
			offset: t.Number({ default: 0, minimum: 0 }),
			cursor: t.Optional(t.Number({ description: "Last event ID for cursor pagination (overrides offset)" })),
		}),
		detail: { summary: "Get pack history", description: "Event history for a specific pack. Use cursor=lastId for efficient pagination." },
	});
