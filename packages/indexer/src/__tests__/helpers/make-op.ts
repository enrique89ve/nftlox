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
}): ParsedOperation {
	const id = ++opCounter;
	const authLevel: AuthLevel =
		params.authLevel ?? (ACTIVE_SET.has(params.action) ? "active" : "posting");
	const txId = (params.txId ?? `tx_${params.action}_${id}`)
		.padEnd(40, "0")
		.slice(0, 40);
	return {
		blockNum: params.blockNum ?? 90_000_100,
		timestamp: new Date().toISOString(),
		txId,
		operationId: `op_${id}`,
		signer: params.signer ?? "alice",
		authLevel,
		action: params.action as ParsedOperation["action"],
		version: PROTOCOL_VERSION,
		data: params.data,
		pairedTransfers: params.pairedTransfers,
	};
}
