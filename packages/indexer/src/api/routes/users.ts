import { Elysia, t } from "elysia";
import { countCollectionsByCreator, getCollectionsByCreator } from "@/db/queries/collections.ts";
import { countLoansByAccount, parseLoanRole, queryLoansByAccount } from "@/db/queries/loans.ts";
import { getUserAssetCounts, queryAssets, queryAssetsWithCounts, parseAssetStatus, parseAssetKind, ASSET_KIND_SEED } from "@/db/queries/assets.ts";

const DEFAULT_ASSETS_PREVIEW_LIMIT = 6;

export const usersRoutes = new Elysia({ prefix: "/api/users", tags: ["Users"] })
	.get("/:username/assets/overview", async ({ params, query }) => {
		const previewLimit = query.previewLimit ?? DEFAULT_ASSETS_PREVIEW_LIMIT;
		const [
			assetCounts,
			collectionsCount,
			lentOutCount,
			borrowedCount,
			owned,
			seeds,
			lentOut,
			borrowed,
			collections,
		] = await Promise.all([
			getUserAssetCounts(params.username),
			countCollectionsByCreator(params.username),
			countLoansByAccount(params.username, "lender"),
			countLoansByAccount(params.username, "borrower"),
			queryAssets({ by: "owner", owner: params.username }, { limit: previewLimit, offset: 0 }),
			queryAssets({ by: "owner", owner: params.username, type: ASSET_KIND_SEED }, { limit: previewLimit, offset: 0 }),
			queryLoansByAccount(params.username, "lender", { limit: previewLimit, offset: 0 }),
			queryLoansByAccount(params.username, "borrower", { limit: previewLimit, offset: 0 }),
			getCollectionsByCreator(params.username, previewLimit, 0),
		]);
		return {
			username: params.username,
			counts: {
				owned: assetCounts.total,
				seeds: assetCounts.seeds,
				collections: collectionsCount,
				lentOut: lentOutCount,
				borrowed: borrowedCount,
			},
			assets: {
				owned,
				seeds,
				lentOut,
				borrowed,
				collections,
			},
			previewLimit,
		};
	}, {
		params: t.Object({ username: t.String({ minLength: 3, maxLength: 16 }) }),
		query: t.Object({
			previewLimit: t.Number({ default: DEFAULT_ASSETS_PREVIEW_LIMIT, minimum: 1, maximum: 20 }),
		}),
		detail: {
			summary: "Get user assets overview",
			description: "Returns a dashboard-oriented overview: owned Assets, seeds, active loans by role, and created collections. Use paginated domain routes for full lists.",
		},
	})
	.get("/:username/assets", async ({ params, query }) => {
		const result = await queryAssetsWithCounts(
			params.username,
			parseAssetStatus(query.status),
			parseAssetKind(query.type),
			{ limit: query.limit, offset: query.offset },
		);
		return { ...result, offset: query.offset, limit: query.limit };
	}, {
		params: t.Object({ username: t.String({ minLength: 3, maxLength: 16 }) }),
		query: t.Object({
			status: t.Optional(t.String({ description: "Filter: active, listed, lent" })),
			type: t.Optional(t.String({ description: "Filter: seed, instance" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get user's Assets with counts" },
	})
	.get("/:username/assets/count", async ({ params }) => {
		return getUserAssetCounts(params.username);
	}, {
		params: t.Object({ username: t.String({ minLength: 3, maxLength: 16 }) }),
		detail: { summary: "Get user's Asset counts", description: "Total counts by type (seeds, instances)" },
	})
	.get("/:username/loans", async ({ params, query }) => {
		const role = parseLoanRole(query.role) ?? "all";
		const [loans, total] = await Promise.all([
			queryLoansByAccount(params.username, role, { limit: query.limit, offset: query.offset }),
			countLoansByAccount(params.username, role),
		]);
		return { username: params.username, role, loans, total, offset: query.offset, limit: query.limit };
	}, {
		params: t.Object({ username: t.String({ minLength: 3, maxLength: 16 }) }),
		query: t.Object({
			role: t.Optional(t.Union([
				t.Literal("lender"),
				t.Literal("borrower"),
				t.Literal("all"),
			], { description: "Loan role: lender, borrower, all" })),
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: {
			summary: "Get user's active loans",
			description: "Returns active lending custody records by lender, borrower, or both. Ownership remains defined by Asset owner fields.",
		},
	})
	.get("/:username/collections", async ({ params, query }) => {
		return getCollectionsByCreator(params.username, query.limit, query.offset);
	}, {
		params: t.Object({ username: t.String({ minLength: 3, maxLength: 16 }) }),
		query: t.Object({
			limit: t.Number({ default: 50, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: { summary: "Get user's collections", description: "Collections created by this user." },
	});
