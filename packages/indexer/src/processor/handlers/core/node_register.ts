import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { Queryable } from "@/db/client.ts";
import { MAX_URL_LENGTH } from "@/protocol/index.ts";
import { requireBoundedString } from "@/utils/validation.ts";

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
 * Node registration is consensus-critical because `buy` settlement accepts
 * only active registered signers. Keep this handler purely deterministic:
 * validate only fields present in the L1 operation and avoid live RPC checks
 * such as current Hive Power, which would make historical replays diverge.
 * Sybil scoring belongs in read-side reputation/discovery, not in this write
 * projection.
 */
export async function handleNodeRegister(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const endpoint = requireNodeEndpoint(op.data.endpoint);
	const publicKey = requireNodePublicKey(op.data.publicKey);

	// Insert into l2_nodes DB table. On re-register we refresh the endpoint,
	// pubkey, and registration block, but preserve the existing `status` —
	// otherwise any future ban could be trivially reset by emitting another
	// node_register. The default 'active' only applies to brand-new rows.
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
			block_num = EXCLUDED.block_num,
			tx_id = EXCLUDED.tx_id,
			updated_at = NOW()
	`;

	return []; // This action evaluates node state, it emits no immutable NFT ids
}
