import { Elysia, t } from "elysia";
import { getNftById, getNftInstances } from "@/db/queries/nfts.ts";
import { getNftHistory, getNftOwnershipChain } from "@/db/queries/history.ts";
import { getOffersByNft } from "@/db/queries/offers.ts";

export const nftsRoutes = new Elysia({ prefix: "/api/nfts", tags: ["NFTs"] })
	.get("/:id", async ({ params }) => {
		const row = await getNftById(params.id);
		if (!row) return new Response(JSON.stringify({ error: "NFT not found" }), { status: 404 });
		return row;
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get NFT by ID", description: "Returns full NFT details including metadata, ownership, and listing info" },
	})
	.get("/:id/history", async ({ params, query }) => {
		return getNftHistory(params.id, query.limit, query.offset, query.cursor);
	}, {
		params: t.Object({ id: t.String() }),
		query: t.Object({
			limit: t.Number({ default: 100, minimum: 1, maximum: 500 }),
			offset: t.Number({ default: 0, minimum: 0 }),
			cursor: t.Optional(t.Number({ description: "Last event ID for cursor pagination (overrides offset)" })),
		}),
		detail: { summary: "Get NFT event history", description: "Chronological list of all events. Use cursor=lastId for efficient pagination." },
	})
	.get("/:id/ownership", async ({ params }) => {
		return getNftOwnershipChain(params.id);
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get ownership chain", description: "Provenance chain showing all ownership transfers" },
	})
	.get("/:id/instances", async ({ params, query }) => {
		return getNftInstances(params.id, query.limit, query.offset);
	}, {
		params: t.Object({ id: t.String() }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get seed instances", description: "List instances distributed from this seed NFT" },
	})
	.get("/:id/offers", async ({ params, query }) => {
		return getOffersByNft(params.id, query.status, query.limit, query.offset);
	}, {
		params: t.Object({ id: t.String() }),
		query: t.Object({
			status: t.Optional(t.String({ description: "Filter: active, accepted, rejected, expired" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get NFT offers" },
	});
