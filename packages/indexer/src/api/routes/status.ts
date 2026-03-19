import { Elysia, t } from "elysia";
import { getLastBlock } from "../../db/queries/sync.ts";
import { getHeadBlockNum } from "../../scanner/hive-client.ts";
import { getProtocolStats } from "../../db/queries/stats.ts";

export const statusRoutes = new Elysia({ tags: ["Status"] })
	.get("/api/status", async () => {
		const [lastBlock, headBlock] = await Promise.all([
			getLastBlock(),
			getHeadBlockNum().catch(() => 0),
		]);
		return {
			lastBlock,
			headBlock,
			blocksBehind: Math.max(0, headBlock - lastBlock),
			syncing: headBlock - lastBlock > 10,
		};
	}, {
		detail: {
			summary: "Sync status",
			description: "Current indexer sync progress and block height",
		},
		response: t.Object({
			lastBlock: t.Number(),
			headBlock: t.Number(),
			blocksBehind: t.Number(),
			syncing: t.Boolean(),
		}),
	})
	.get("/api/stats", async () => {
		return getProtocolStats();
	}, {
		detail: {
			summary: "Protocol statistics",
			description: "Aggregate counts: collections, NFTs, sales, offers, etc.",
		},
	});
