import { Elysia, t } from "elysia";
import { getFormattedStateRoot } from "@/db/queries/state-root.ts";

// Public commitment to the projected NFT ownership state. Any two indexers
// processing the same HafAH stream MUST converge on the same value — so
// divergence between independent nodes is a single byte comparison away.
//
// This endpoint is O(1): it reads the singleton `state_meta` row. Throughput
// is bounded only by the DB connection pool; no recomputation happens here.
// The hash itself is maintained incrementally inside the NFT mutation path
// (see db/queries/state-root.ts).
//
// Callers verify ownership against HafAH using the SPV fields exposed in the
// per-NFT routes; the state-root is a complementary tool for comparing whole
// projections across nodes, not a replacement for per-row verification.
export const stateRootRoutes = new Elysia({ tags: ["Status"] })
	.get("/api/state-root", async () => {
		return await getFormattedStateRoot();
	}, {
		response: t.Object({
			state_root: t.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
			nft_count: t.Integer({ minimum: 0 }),
			last_block_num: t.Integer({ minimum: 0 }),
			updated_at: t.String(),
		}),
		detail: {
			summary: "Projected-state commitment",
			description: "Returns the incremental XOR state-root over all NFT SPV fields (owner, previous_owner, owner_action, owner_operation_id, owner_block_num, id). Two indexers on the same stream converge to the same value; divergence is a single byte comparison.",
		},
	});
