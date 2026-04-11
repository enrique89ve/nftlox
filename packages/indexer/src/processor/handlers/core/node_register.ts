import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { Queryable } from "@/db/client.ts";
import { MAX_URL_LENGTH } from "@/protocol/constants.ts";
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

export async function handleNodeRegister(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const endpoint = requireNodeEndpoint(op.data.endpoint);
	const publicKey = requireNodePublicKey(op.data.publicKey);

	// Insert into l2_nodes DB table
	await txn`
		INSERT INTO l2_nodes (
			account,
			endpoint,
			public_key,
			status,
			fee_paid_hbd,
			fee_paid_hive,
			block_num,
			tx_id
		) VALUES (
			${op.signer},
			${endpoint},
			${publicKey},
			'active',
			0,
			0,
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
