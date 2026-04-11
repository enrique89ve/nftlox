import { Elysia, t } from "elysia";
import { getNftById, getNftOwnerClaim, getNftOwnershipProof, getSeedSummary, queryNfts, queryRawInstances } from "@/db/queries/nfts.ts";
import { getNftLoan } from "@/db/queries/loans.ts";

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
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: { summary: "Get NFT by ID", description: "Returns full NFT details including metadata, ownership, and listing info" },
	})
	.get("/:id/owner", async ({ params }) => {
		const row = await getNftOwnerClaim(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "NFT not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get current NFT owner",
			description: "Returns the current owner claim and its HafAH operation anchor with one NFT-row lookup.",
		},
	})
	.get("/:id/ownership", async ({ params }) => {
		const row = await getNftOwnershipProof(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "NFT not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get NFT ownership claim",
			description: "Returns the current ownership edge plus creation anchors for SDK/HafAH verification.",
		},
	})
	.get("/:id/proof", async ({ params }) => {
		const row = await getNftOwnershipProof(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "NFT not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get NFT ownership proof",
			description: "Returns the minimal ownership-proof contract used by the SDK SPV verifier",
		},
	})
	.get("/:id/loan", async ({ params }) => {
		const nft = await getNftById(params.id);
		if (!nft) {
			return new Response(JSON.stringify({ error: "NFT not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		const loan = await getNftLoan(params.id);
		return { nft_id: params.id, active: loan !== null, loan };
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get NFT loan status",
			description: "Returns active loan custody for this NFT without changing ownership semantics.",
		},
	})
	.get("/:id/instances", async ({ params, query }) => {
		if (query.compact) {
			const [seed, instances] = await Promise.all([
				getSeedSummary(params.id),
				queryRawInstances(params.id, { limit: query.limit, offset: query.offset }),
			]);
			if (!seed) {
				return new Response(JSON.stringify({ error: "Seed not found" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}
			return { seed, instances };
		}
		return queryNfts({ by: "seed", seedId: params.id }, { limit: query.limit, offset: query.offset });
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
			compact: t.Boolean({ default: false }),
		}),
		detail: {
			summary: "Get seed instances",
			description: "List instances distributed from this seed NFT. Use compact=true for zero-duplication mode (seed sent once + instance deltas).",
		},
	});
