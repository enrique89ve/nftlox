import { Elysia, t } from "elysia";
import { getNftsByOwner } from "@/db/queries/nfts.ts";
import { getCollectionsByCreator } from "@/db/queries/collections.ts";
import { getUserActivity } from "@/db/queries/history.ts";
import { getUserPackBalances } from "@/db/queries/packs.ts";

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
		return getUserActivity(params.username, query.limit, query.offset, query.cursor);
	}, {
		params: t.Object({ username: t.String() }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
			cursor: t.Optional(t.Number({ description: "Last event ID for cursor pagination (overrides offset)" })),
		}),
		detail: { summary: "Get user activity", description: "All events where user is sender or receiver. Use cursor=lastId for efficient pagination." },
	})
	.get("/:username/packs", async ({ params, query }) => {
		return getUserPackBalances(params.username, query.limit, query.offset);
	}, {
		params: t.Object({ username: t.String() }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get user's packs", description: "Pack balances for a user (only packs with balance > 0)" },
	});
