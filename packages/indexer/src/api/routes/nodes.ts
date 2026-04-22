import { Elysia, t } from "elysia";
import { getLastBlock } from "@/db/queries/sync.ts";
import {
	getNodeProfile,
	listIndexedNodeOperations,
} from "@/db/queries/nodes.ts";

const DEFAULT_INDEXED_LIMIT = 50;

function normalizeNodeAccount(value: string): string {
	return value.trim().toLowerCase();
}

export const nodesRoutes = new Elysia({ prefix: "/api/nodes", tags: ["Nodes"] })
	.get("/:account", async ({ params, set }) => {
		const account = normalizeNodeAccount(params.account);
		const lastBlock = await getLastBlock();
		const profile = await getNodeProfile(account, lastBlock);
		if (!profile) {
			set.status = 404;
			return { error: "Node not found" };
		}
		return profile;
	}, {
		params: t.Object({ account: t.String({ minLength: 3, maxLength: 16 }) }),
		detail: {
			summary: "Get node profile",
			description: "Returns registry metadata, heartbeat summary, and settlement liveness for one node account.",
		},
	})
	.get("/:account/operations", async ({ params, query }) => {
		const account = normalizeNodeAccount(params.account);
		return listIndexedNodeOperations(account, { limit: query.limit, offset: query.offset });
	}, {
		params: t.Object({ account: t.String({ minLength: 3, maxLength: 16 }) }),
		query: t.Object({
			limit: t.Number({ default: DEFAULT_INDEXED_LIMIT, minimum: 1, maximum: 200 }),
			offset: t.Number({ default: 0, minimum: 0 }),
		}),
		detail: {
			summary: "List indexed protocol operations signed by a node",
			description: "Returns confirmed and invalid protocol operations whose signer is this node account, ordered newest-first.",
		},
	});
