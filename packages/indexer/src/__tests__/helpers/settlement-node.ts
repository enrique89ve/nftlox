import { sql, type Queryable } from "@/db/client.ts";

export type SeedNodeOpts = Readonly<{
	/**
	 * Block at which the node was registered / last heartbeated. Both columns
	 * are set to the same value so the node is considered fresh at any
	 * evaluation block in `[registeredBlock, registeredBlock + MAX_STALENESS]`.
	 * Default 1 (works for any op with blockNum in that range).
	 */
	registeredBlock?: number;
}>;

/**
 * Inserts a registered+active settlement node for tests that drive operations
 * through `routeOperation`. After the consensus refactor (fee recipient derived
 * from `op.signer`), the router rejects any fixed/scaled-payment action unless
 * `op.signer` is an active node — so every router-level test must seed this.
 *
 * Idempotent: upserts the row so repeated calls inside the same test are safe.
 */
export async function seedActiveSettlementNode(
	account: string,
	opts: SeedNodeOpts = {},
	txn: Queryable = sql,
): Promise<void> {
	const registeredBlock = opts.registeredBlock ?? 1;
	await txn`
		INSERT INTO l2_nodes (
			account,
			endpoint,
			status,
			block_num,
			last_heartbeat_block,
			tx_id
		) VALUES (
			${account},
			${`${account}.example.com`},
			'active',
			${registeredBlock},
			${registeredBlock},
			${`tx_node_${account}`}
		)
		ON CONFLICT (account) DO UPDATE SET
			endpoint = EXCLUDED.endpoint,
			status = 'active',
			block_num = EXCLUDED.block_num,
			last_heartbeat_block = EXCLUDED.last_heartbeat_block,
			tx_id = EXCLUDED.tx_id,
			updated_at = NOW()
	`;
}
