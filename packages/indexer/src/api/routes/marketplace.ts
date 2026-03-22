import { Elysia, t } from "elysia";
import { queryNfts } from "@/db/queries/nfts.ts";

export const marketplaceRoutes = new Elysia({ prefix: "/api/marketplace", tags: ["Marketplace"] })
	.get("/listings", async ({ query }) => {
		return queryNfts(
			{ by: "listed", sort: query.sort, currency: query.currency },
			{ limit: query.limit, offset: query.offset },
		);
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
	});
