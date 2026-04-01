import { Elysia, t } from "elysia";
import { queryNfts } from "@/db/queries/nfts.ts";
import { getSalesByCollection, getSalesByNft, getSalesByAccount, getSalesVolume, getRecentSales } from "@/db/queries/marketplace-history.ts";

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
	})
	.get("/sales", async ({ query }) => {
		if (query.nftId) return getSalesByNft(query.nftId, query.limit, query.offset);
		if (query.collectionId) return getSalesByCollection(query.collectionId, query.limit, query.offset);
		if (query.seller) return getSalesByAccount(query.seller, "seller", query.limit, query.offset);
		if (query.buyer) return getSalesByAccount(query.buyer, "buyer", query.limit, query.offset);
		return getRecentSales(query.limit, query.offset);
	}, {
		query: t.Object({
			nftId: t.Optional(t.String({ description: "Filter by NFT ID" })),
			collectionId: t.Optional(t.String({ description: "Filter by collection ID" })),
			seller: t.Optional(t.String({ description: "Filter by seller account" })),
			buyer: t.Optional(t.String({ description: "Filter by buyer account" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get sales history", description: "Browse completed sales with financial split (royalties, fees, seller net)" },
	})
	.get("/volume", async ({ query }) => {
		return getSalesVolume(query.collectionId);
	}, {
		query: t.Object({
			collectionId: t.Optional(t.String({ description: "Filter by collection ID" })),
		}),
		detail: { summary: "Get sales volume", description: "Aggregated volume by currency with royalties and fees breakdown" },
	});
