import { Elysia, t } from "elysia";
import { getUserNftCounts, queryNftsWithCounts, parseNftStatus, parseNftKind } from "@/db/queries/nfts.ts";

export const usersRoutes = new Elysia({ prefix: "/api/users", tags: ["Users"] })
	.get("/:username/nfts", async ({ params, query }) => {
		const result = await queryNftsWithCounts(
			params.username,
			parseNftStatus(query.status),
			parseNftKind(query.type),
			{ limit: query.limit, offset: query.offset },
		);
		return { ...result, offset: query.offset, limit: query.limit };
	}, {
		params: t.Object({ username: t.String({ minLength: 3, maxLength: 16 }) }),
		query: t.Object({
			status: t.Optional(t.String({ description: "Filter: active, listed, lent" })),
			type: t.Optional(t.String({ description: "Filter: seed, instance, replica" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get user's NFTs with counts" },
	})
	.get("/:username/nfts/count", async ({ params }) => {
		return getUserNftCounts(params.username);
	}, {
		params: t.Object({ username: t.String({ minLength: 3, maxLength: 16 }) }),
		detail: { summary: "Get user's NFT counts", description: "Total counts by type (seeds, instances, replicas)" },
	});
