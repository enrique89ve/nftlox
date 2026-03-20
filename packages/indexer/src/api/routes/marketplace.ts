import { Elysia, t } from "elysia";
import { getListedNfts } from "@/db/queries/nfts.ts";
import { getRecentSales } from "@/db/queries/history.ts";

export const marketplaceRoutes = new Elysia({ prefix: "/api/marketplace", tags: ["Marketplace"] })
	.get("/listings", async ({ query }) => {
		return getListedNfts(query.sort, query.currency, query.limit, query.offset);
	}, {
		query: t.Object({
			sort: t.Optional(t.Union([
				t.Literal("price_asc"),
				t.Literal("price_desc"),
				t.Literal("recent"),
			], { default: "recent", description: "Sort order" })),
			currency: t.Optional(t.String({ description: "Filter by currency: HIVE, HBD" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get active listings", description: "Browse NFTs currently listed for sale" },
	})
	.get("/recent-sales", async ({ query }) => {
		return getRecentSales(query.limit, query.offset, query.cursor);
	}, {
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
			cursor: t.Optional(t.Number({ description: "Last event ID for cursor pagination (overrides offset)" })),
		}),
		detail: { summary: "Get recent sales. Use cursor=lastId for efficient pagination." },
	});
