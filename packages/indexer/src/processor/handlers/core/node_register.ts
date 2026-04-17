import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { Queryable } from "@/db/client.ts";
import { MAX_URL_LENGTH, MIN_NODE_REGISTER_HIVE_POWER } from "@/protocol/index.ts";
import { requireBoundedString } from "@/utils/validation.ts";
import { getEffectiveHivePower } from "@/scanner/hive-client.ts";

const MAX_NODE_PUBLIC_KEY_LENGTH = 256;

function requireNodeEndpoint(value: unknown): string {
	const endpoint = requireBoundedString(value, "endpoint", MAX_URL_LENGTH).trim();
	if (endpoint === "") {
		throw new Error("Missing or invalid 'endpoint' parameter");
	}

	try {
		const url = new URL(endpoint);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new Error("unsupported protocol");
		}
	} catch {
		throw new Error("Invalid 'endpoint' parameter: expected http(s) URL");
	}

	return endpoint;
}

function requireNodePublicKey(value: unknown): string {
	const publicKey = requireBoundedString(value, "publicKey", MAX_NODE_PUBLIC_KEY_LENGTH).trim();
	if (publicKey.length < 10) {
		throw new Error("Missing or invalid 'publicKey' parameter");
	}
	return publicKey;
}

/**
 * Anti-sybil gate for the PUBLIC node directory. Running a node is
 * permissionless and does not require any registration — a game or dapp
 * operator can index the chain and serve their own app without ever
 * emitting `node_register`. This op is only for nodes that *opt in* to be
 * listed in `l2_nodes` and discovered by clients, and that is what the HP
 * floor protects against (cheap sybil listings).
 *
 * Skin-in-the-game is HP itself (self-staked + received delegations −
 * out-delegations), which is reversible but subject to the 13-week Hive
 * power-down schedule. No fee is charged.
 */
async function requireSufficientHivePower(account: string): Promise<void> {
	const hp = await getEffectiveHivePower(account);
	if (hp === null) {
		throw new Error(`Unable to verify Hive Power for account '${account}' (public node directory)`);
	}
	if (hp < MIN_NODE_REGISTER_HIVE_POWER) {
		throw new Error(
			`Account '${account}' has ${hp.toFixed(3)} HP, public node directory requires at least ${MIN_NODE_REGISTER_HIVE_POWER} HP (private nodes do not need to register)`,
		);
	}
}

export async function handleNodeRegister(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const endpoint = requireNodeEndpoint(op.data.endpoint);
	const publicKey = requireNodePublicKey(op.data.publicKey);

	await requireSufficientHivePower(op.signer);

	// Insert into l2_nodes DB table
	await txn`
		INSERT INTO l2_nodes (
			account,
			endpoint,
			public_key,
			status,
			block_num,
			tx_id
		) VALUES (
			${op.signer},
			${endpoint},
			${publicKey},
			'active',
			${op.blockNum},
			${op.txId}
		)
		ON CONFLICT (account) DO UPDATE SET
			endpoint = EXCLUDED.endpoint,
			public_key = EXCLUDED.public_key,
			status = 'active',
			block_num = EXCLUDED.block_num,
			tx_id = EXCLUDED.tx_id,
			updated_at = NOW()
	`;

	return []; // This action evaluates node state, it emits no immutable NFT ids
}
