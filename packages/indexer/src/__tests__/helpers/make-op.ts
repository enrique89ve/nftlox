import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import { ACTIVE_AUTH_ACTIONS, PROTOCOL_VERSION } from "@/protocol/index.ts";

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);

let opCounter = 0;

export function makeOp(params: {
	readonly action: string;
	readonly data: Record<string, unknown>;
	readonly signer?: string;
	readonly blockNum?: number;
	readonly txId?: string;
	readonly pairedTransfers?: ParsedOperation["pairedTransfers"];
	readonly authLevel?: AuthLevel;
	// Explicit chain timestamp (ISO-8601). Default uses wall clock so existing
	// tests stay backward-compatible; replay-determinism fixtures pin a fixed
	// value derived from blockNum so two runs produce byte-identical hashes.
	readonly timestamp?: string;
	// Explicit operation id. Default uses the module-private counter so existing
	// tests keep their semantics. Replay-determinism fixtures pin an op-tag-
	// derived id because `owner_operation_id` is hashed into the state-root.
	readonly operationId?: string;
}): ParsedOperation {
	const id = ++opCounter;
	const authLevel: AuthLevel =
		params.authLevel ?? (ACTIVE_SET.has(params.action) ? "active" : "posting");
	const txId = (params.txId ?? `tx_${params.action}_${id}`)
		.padEnd(40, "0")
		.slice(0, 40);
	return {
		blockNum: params.blockNum ?? 90_000_100,
		timestamp: params.timestamp ?? new Date().toISOString(),
		txId,
		operationId: params.operationId ?? `op_${id}`,
		signer: params.signer ?? "alice",
		authLevel,
		action: params.action as ParsedOperation["action"],
		version: PROTOCOL_VERSION,
		data: params.data,
		pairedTransfers: params.pairedTransfers,
	};
}
