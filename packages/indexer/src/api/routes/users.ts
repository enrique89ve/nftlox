import { Elysia, t } from "elysia";
import { getNftsByOwner } from "../../db/queries/nfts.ts";
import { getCollectionsByCreator } from "../../db/queries/collections.ts";
import { getUserActivity } from "../../db/queries/history.ts";

export const usersRoutes = new Elysia({ prefix: "/api/users", tags: ["Users"] })
	.get("/:username/nfts", async ({ params, query }) => {
		return getNftsByOwner(params.username, query.status, query.type, query.limit, query.offset);
	}, {
		params: t.Object({ username: t.String() }),
		query: t.Object({
			status: t.Optional(t.String({ description: "Filter: active, listed, burned" })),
			type: t.Optional(t.String({ description: "Filter: seed, instance, replica" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get user's NFTs" },
	})
	.get("/:username/collections", async ({ params, query }) => {
		return getCollectionsByCreator(params.username, query.limit, query.offset);
	}, {
		params: t.Object({ username: t.String() }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get user's collections" },
	})
	.get("/:username/activity", async ({ params, query }) => {
		return getUserActivity(params.username, query.limit, query.offset);
	}, {
		params: t.Object({ username: t.String() }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get user activity", description: "All events where user is sender or receiver" },
	});
