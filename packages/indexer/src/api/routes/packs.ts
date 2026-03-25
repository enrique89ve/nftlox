import { Elysia, t } from "elysia";
import { listPacks, getPackById } from "@/db/queries/packs.ts";

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
		if (!pack) {
			return new Response(JSON.stringify({ error: "Pack not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return pack;
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get pack by ID" },
	});
