import { Elysia, t } from "elysia";
import { getNftById, queryNfts } from "@/db/queries/nfts.ts";

export const nftsRoutes = new Elysia({ prefix: "/api/nfts", tags: ["NFTs"] })
	.get("/:id", async ({ params }) => {
		const row = await getNftById(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "NFT not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String() }),
		detail: { summary: "Get NFT by ID", description: "Returns full NFT details including metadata, ownership, and listing info" },
	})
	.get("/:id/instances", async ({ params, query }) => {
		return queryNfts({ by: "seed", seedId: params.id }, { limit: query.limit, offset: query.offset });
	}, {
		params: t.Object({ id: t.String() }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get seed instances", description: "List instances distributed from this seed NFT" },
	});
