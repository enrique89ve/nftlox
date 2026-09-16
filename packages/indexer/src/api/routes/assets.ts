import { Elysia, t } from "elysia";
import { getAssetById, getAssetsByIds, getAssetOwnerClaim, getAssetOwnershipProof, getSeedSummary, queryAssets, queryRawInstances } from "@/db/queries/assets.ts";
import { getAssetLoan } from "@/db/queries/loans.ts";

// Same per-id constraints as /api/assets/:id, plus a hard cap on the batch size
// so a bot cannot bypass Elysia's URL-size limit to DoS the query planner.
const ASSET_ID_MIN = 1;
const ASSET_ID_MAX = 128;
const MAX_BATCH_IDS = 200;

type BatchIdsOutcome =
	| Readonly<{ ok: true; ids: ReadonlyArray<string> }>
	| Readonly<{ ok: false; error: string }>;

function parseBatchIdsParam(raw: string): BatchIdsOutcome {
	// Trim and filter empties up-front so ",,a,b," still works intuitively.
	const parts = raw.split(",").map(s => s.trim()).filter(s => s.length > 0);
	if (parts.length === 0) return { ok: false, error: "ids must contain at least one id" };
	for (const id of parts) {
		if (id.length < ASSET_ID_MIN || id.length > ASSET_ID_MAX) {
			return { ok: false, error: `invalid id: length must be ${ASSET_ID_MIN}..${ASSET_ID_MAX}` };
		}
	}
	// Dedupe while preserving first-occurrence order — bots often request the same
	// id twice by accident, and duplicates would bloat the IN() array for nothing.
	const deduped = Array.from(new Set(parts));
	if (deduped.length > MAX_BATCH_IDS) {
		return { ok: false, error: `too many ids: max ${MAX_BATCH_IDS}` };
	}
	return { ok: true, ids: deduped };
}

export const assetsRoutes = new Elysia({ prefix: "/api/assets", tags: ["Assets"] })
	.get("/", async ({ query, set }) => {
		const parsed = parseBatchIdsParam(query.ids);
		if (!parsed.ok) {
			set.status = 400;
			return { error: parsed.error };
		}
		const rows = await getAssetsByIds(parsed.ids);
		const returned = new Set(rows.map(r => String(r.id)));
		const missing = parsed.ids.filter(id => !returned.has(id));
		return { items: rows, missing };
	}, {
		query: t.Object({
			ids: t.String({
				minLength: 1,
				description: `Comma-separated Asset ids. Each id must be ${ASSET_ID_MIN}..${ASSET_ID_MAX} chars; duplicates are deduped and the batch is capped at ${MAX_BATCH_IDS} ids.`,
			}),
		}),
		detail: {
			summary: "Batch get Assets by IDs",
			description: `Returns \`{ items: AssetRow[], missing: string[] }\`. Distributors confirming a bulk_distribute can swap N per-id GETs for one batch read. Ids must be comma-separated; the batch is capped at ${MAX_BATCH_IDS} to keep the query planner fast. Not-yet-indexed ids are reported in \`missing\` instead of 404, so bots can poll without error-parsing.`,
		},
	})
	.get("/:id", async ({ params }) => {
		const row = await getAssetById(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "Asset not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: { summary: "Get Asset by ID", description: "Returns full Asset details including metadata, ownership, and listing info" },
	})
	.get("/:id/owner", async ({ params }) => {
		const row = await getAssetOwnerClaim(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "Asset not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get current Asset owner",
			description: "Returns the current owner claim and its HafAH operation anchor with one Asset-row lookup.",
		},
	})
	.get("/:id/ownership", async ({ params }) => {
		const row = await getAssetOwnershipProof(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "Asset not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get Asset ownership claim",
			description: "Returns the current ownership edge plus creation anchors for SDK/HafAH verification.",
		},
	})
	.get("/:id/proof", async ({ params }) => {
		const row = await getAssetOwnershipProof(params.id);
		if (!row) {
			return new Response(JSON.stringify({ error: "Asset not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return row;
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get Asset ownership proof",
			description: "Returns the minimal ownership-proof contract used by the SDK SPV verifier",
		},
	})
	.get("/:id/loan", async ({ params }) => {
		const asset = await getAssetById(params.id);
		if (!asset) {
			return new Response(JSON.stringify({ error: "Asset not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		const loan = await getAssetLoan(params.id);
		return { asset_id: params.id, active: loan !== null, loan };
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get Asset loan status",
			description: "Returns active loan custody for this Asset without changing ownership semantics.",
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
		return queryAssets({ by: "seed", seedId: params.id }, { limit: query.limit, offset: query.offset });
	}, {
		params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
			compact: t.Boolean({ default: false }),
		}),
		detail: {
			summary: "Get seed instances",
			description: "List instances distributed from this seed Asset. Use compact=true for zero-duplication mode (seed sent once + instance deltas).",
		},
	});
